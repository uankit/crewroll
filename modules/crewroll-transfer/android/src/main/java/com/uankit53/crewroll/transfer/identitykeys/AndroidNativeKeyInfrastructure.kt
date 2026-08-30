package com.uankit53.crewroll.transfer.identitykeys

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import com.goterl.lazysodium.SodiumAndroid
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.spec.ECGenParameterSpec
import java.time.Instant

class AndroidSodiumCrypto : NativeKeyCrypto {
  private val sodium = SodiumAndroid()

  init {
    if (sodium.sodium_init() < 0) throw NativeKeyException.materialLost()
  }

  override fun randomBytes(count: Int): ByteArray {
    if (count <= 0) throw NativeKeyException.invalidCommand()
    return try {
      ByteArray(count).also { sodium.randombytes_buf(it, count) }
    } catch (_: Throwable) {
      throw NativeKeyException.materialLost()
    }
  }

  override fun makeX25519KeyPair(): X25519KeyPair {
    val publicKey = ByteArray(32)
    val privateKey = ByteArray(32)
    return try {
      if (sodium.crypto_box_keypair(publicKey, privateKey) != 0) {
        throw NativeKeyException.materialLost()
      }
      X25519KeyPair(publicKey, privateKey)
    } catch (error: NativeKeyException) {
      privateKey.fill(0)
      throw error
    } catch (_: Throwable) {
      privateKey.fill(0)
      throw NativeKeyException.materialLost()
    }
  }

  override fun deriveX25519PublicKey(privateKey: ByteArray): ByteArray {
    if (privateKey.size != 32) throw NativeKeyException.materialLost()
    val privateCopy = privateKey.copyOf()
    val publicKey = ByteArray(32)
    return try {
      if (sodium.crypto_scalarmult_base(publicKey, privateCopy) != 0) {
        throw NativeKeyException.materialLost()
      }
      publicKey
    } catch (error: NativeKeyException) {
      publicKey.fill(0)
      throw error
    } catch (_: Throwable) {
      publicKey.fill(0)
      throw NativeKeyException.materialLost()
    } finally {
      zeroize(privateCopy)
    }
  }

  override fun constantTimeEquals(lhs: ByteArray, rhs: ByteArray): Boolean {
    if (lhs.size != rhs.size) return false
    return try {
      sodium.sodium_memcmp(lhs, rhs, lhs.size) == 0
    } catch (_: Throwable) {
      false
    }
  }

  override fun zeroize(value: ByteArray) {
    if (value.isEmpty()) return
    try {
      sodium.sodium_memzero(value, value.size)
    } catch (_: Throwable) {
      value.fill(0)
    }
  }

  override fun seal(plaintext: ByteArray, recipientPublicKey: ByteArray): ByteArray {
    if (plaintext.size != 100 || recipientPublicKey.size != 32) {
      throw NativeKeyException.invalidEnvelope()
    }
    val message = plaintext.copyOf()
    val recipient = recipientPublicKey.copyOf()
    val output = ByteArray(148)
    return try {
      if (sodium.crypto_box_seal(output, message, message.size.toLong(), recipient) != 0) {
        throw NativeKeyException.invalidEnvelope()
      }
      output
    } catch (error: NativeKeyException) {
      output.fill(0)
      throw error
    } catch (_: Throwable) {
      output.fill(0)
      throw NativeKeyException.materialLost()
    } finally {
      zeroize(message)
      zeroize(recipient)
    }
  }

  override fun open(
    ciphertext: ByteArray,
    publicKey: ByteArray,
    privateKey: ByteArray,
  ): ByteArray {
    if (ciphertext.size != 148 || publicKey.size != 32 || privateKey.size != 32) {
      throw NativeKeyException.invalidEnvelope()
    }
    val sealed = ciphertext.copyOf()
    val publicCopy = publicKey.copyOf()
    val privateCopy = privateKey.copyOf()
    val output = ByteArray(100)
    return try {
      if (sodium.crypto_box_seal_open(
          output,
          sealed,
          sealed.size.toLong(),
          publicCopy,
          privateCopy,
        ) != 0
      ) {
        throw NativeKeyException.invalidEnvelope()
      }
      output
    } catch (error: NativeKeyException) {
      output.fill(0)
      throw error
    } catch (_: Throwable) {
      output.fill(0)
      throw NativeKeyException.materialLost()
    } finally {
      zeroize(sealed)
      zeroize(publicCopy)
      zeroize(privateCopy)
    }
  }
}

class AndroidP256IdentityProvider : P256IdentityProvider {
  override fun createPublicKey(scope: NativeKeyScope): ByteArray = try {
    val alias = androidP256Alias(scope)
    val keyStore = keyStore()
    if (keyStore.containsAlias(alias)) throw NativeKeyException.materialLost()
    encode(createKey(alias, strongBox = true))
  } catch (error: NativeKeyException) {
    throw error
  } catch (_: Throwable) {
    throw NativeKeyException.materialLost()
  }

  override fun loadPublicKey(scope: NativeKeyScope): ByteArray? = try {
    val alias = androidP256Alias(scope)
    val keyStore = keyStore()
    val certificate = keyStore.getCertificate(alias) ?: return null
    val privateKey = keyStore.getKey(alias, null) as? PrivateKey
      ?: throw NativeKeyException.materialLost()
    if (privateKey.encoded != null) throw NativeKeyException.materialLost()
    encode(certificate.publicKey)
  } catch (error: NativeKeyException) {
    throw error
  } catch (_: Throwable) {
    throw NativeKeyException.materialLost()
  }

  private fun keyStore() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

  private fun createKey(alias: String, strongBox: Boolean): java.security.PublicKey {
    val generator = KeyPairGenerator.getInstance(
      KeyProperties.KEY_ALGORITHM_EC,
      "AndroidKeyStore",
    )
    val builder = KeyGenParameterSpec.Builder(
      alias,
      KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY,
    ).setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
      .setDigests(KeyProperties.DIGEST_SHA256)
      .setUserAuthenticationRequired(false)
    if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      builder.setIsStrongBoxBacked(true)
    }
    return try {
      generator.initialize(builder.build())
      generator.generateKeyPair().public
    } catch (_: StrongBoxUnavailableException) {
      createKey(alias, strongBox = false)
    }
  }

  private fun encode(publicKey: java.security.PublicKey): ByteArray {
    val ec = publicKey as? java.security.interfaces.ECPublicKey
      ?: throw NativeKeyException.materialLost()
    return byteArrayOf(0x04) + fixedUnsigned(ec.w.affineX) + fixedUnsigned(ec.w.affineY)
  }

  private fun fixedUnsigned(value: BigInteger): ByteArray {
    val raw = value.toByteArray().dropWhile { it == 0.toByte() }.toByteArray()
    if (raw.size > 32) throw NativeKeyException.materialLost()
    return ByteArray(32 - raw.size) + raw
  }
}

object AndroidNativeKeyInfrastructure {
  fun makeLifecycle(context: Context) = NativeKeyLifecycle(
    NativeKeyClock(Instant::now),
    AndroidAccountScopedKeyStore(context),
    AndroidSodiumCrypto(),
    AndroidP256IdentityProvider(),
    AndroidAccountNamespaceHasher(),
    ExecutorNativeKeyCleanupScheduler(),
  )
}
