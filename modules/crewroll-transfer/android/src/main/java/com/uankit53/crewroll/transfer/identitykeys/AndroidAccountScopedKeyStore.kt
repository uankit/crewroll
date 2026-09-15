package com.uankit53.crewroll.transfer.identitykeys

import android.content.Context
import android.os.Build
import android.os.UserManager
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.StandardCopyOption.REPLACE_EXISTING
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class AndroidAccountNamespaceHasher : AccountNamespaceHasher {
  override fun hash(accountId: String): String {
    val input = accountId.toByteArray(Charsets.US_ASCII)
    return try {
      MessageDigest.getInstance("SHA-256").digest(input).joinToString("") { "%02x".format(it) }
    } catch (_: Throwable) {
      throw NativeKeyException.materialLost()
    } finally {
      input.fill(0)
    }
  }
}

class AndroidAccountScopedKeyStore(context: Context) :
  NativeKeyStore by AccountScopedKeyStore(AndroidScopedDatabaseFile(context))

private class AndroidScopedDatabaseFile(context: Context) : ScopedDatabasePersistence {
  private val appContext = context.applicationContext
  private val userManager = appContext.getSystemService(UserManager::class.java)
  private val directory = File(appContext.noBackupFilesDir, "crewroll-native-keys-v2")
  private val databaseFile = File(directory, "scoped-database.v2")
  private val temporaryFile = File(directory, "scoped-database.v2.tmp")
  private val random = SecureRandom()
  private val keyAlias = "crewroll.native-record-kek.v2"
  private val legacyOuterMagic = "CRK2".toByteArray(Charsets.US_ASCII)
  private val outerMagic = "CRK3".toByteArray(Charsets.US_ASCII)
  private val legacyOuterAad = "CRKEYDB2|account-hash|installation|1".toByteArray(Charsets.US_ASCII)
  private val outerAad = "CRKEYDB3|atomic-container|2".toByteArray(Charsets.US_ASCII)

  override fun load(): AndroidScopedDatabase {
    requireUnlocked()
    if (!databaseFile.exists()) {
      if (temporaryFile.exists()) throw NativeKeyException.materialLost()
      return AndroidScopedDatabase()
    }
    var record = ByteArray(0)
    var plaintext = ByteArray(0)
    return try {
      record = databaseFile.readBytes()
      if (record.size < 33) {
        throw NativeKeyException.materialLost()
      }
      val aad = when {
        record.copyOfRange(0, 4).contentEquals(legacyOuterMagic) -> legacyOuterAad
        record.copyOfRange(0, 4).contentEquals(outerMagic) -> outerAad
        else -> throw NativeKeyException.materialLost()
      }
      val key = existingKek()
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, record.copyOfRange(4, 16)))
      cipher.updateAAD(aad)
      plaintext = cipher.doFinal(record.copyOfRange(16, record.size))
      AndroidScopedDatabaseCodec.decode(plaintext, AesGcmScopedSecretCipher(key, random))
    } catch (error: NativeKeyException) {
      throw error
    } catch (_: AEADBadTagException) {
      throw NativeKeyException.materialLost()
    } catch (_: Throwable) {
      throw NativeKeyException.materialLost()
    } finally {
      plaintext.fill(0)
      record.fill(0)
    }
  }

  override fun save(database: AndroidScopedDatabase) {
    requireUnlocked()
    var plaintext = ByteArray(0)
    var ciphertext = ByteArray(0)
    var record = ByteArray(0)
    try {
      if (!directory.exists() && !directory.mkdirs()) throw NativeKeyException.materialLost()
      val key = kekForWrite()
      plaintext = AndroidScopedDatabaseCodec.encode(database, AesGcmScopedSecretCipher(key, random))
      ciphertext = AesGcmScopedSecretCipher(key, random).seal(plaintext, outerAad)
      record = outerMagic + ciphertext
      FileOutputStream(temporaryFile).use { output ->
        output.write(record)
        output.fd.sync()
      }
      Files.move(temporaryFile.toPath(), databaseFile.toPath(), REPLACE_EXISTING, ATOMIC_MOVE)
    } catch (error: NativeKeyException) {
      throw error
    } catch (_: Throwable) {
      throw NativeKeyException.materialLost()
    } finally {
      plaintext.fill(0)
      ciphertext.fill(0)
      record.fill(0)
    }
  }

  private fun requireUnlocked() {
    if (!userManager.isUserUnlocked || appContext.isDeviceProtectedStorage) {
      throw NativeKeyException.accessLocked()
    }
  }

  private fun existingKek(): SecretKey {
    val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    return keyStore.getKey(keyAlias, null) as? SecretKey ?: throw NativeKeyException.materialLost()
  }

  private fun kekForWrite(): SecretKey {
    val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (keyStore.getKey(keyAlias, null) as? SecretKey)?.let { return it }
    if (databaseFile.exists()) throw NativeKeyException.materialLost()
    return generateKek(strongBox = true)
  }

  private fun generateKek(strongBox: Boolean): SecretKey {
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    val builder = KeyGenParameterSpec.Builder(
      keyAlias,
      KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
    ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setKeySize(256)
      .setRandomizedEncryptionRequired(true)
      .setUserAuthenticationRequired(false)
    if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) builder.setIsStrongBoxBacked(true)
    return try {
      generator.init(builder.build())
      generator.generateKey()
    } catch (_: StrongBoxUnavailableException) {
      generateKek(strongBox = false)
    }
  }
}
