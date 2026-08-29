# CrewRoll Encryption Format V1

Status: normative, language-neutral wire contract for CON-002.

This document defines the only accepted version-one representation for photo
variants, their encrypted manifest, and trip-key envelopes. Implementations
must call the named libsodium primitives and assert their published widths.
They must not reproduce primitive internals. Unknown versions, fields, tags,
lengths, encodings, or algorithms fail closed before plaintext is saveable.

The binding security policies are [key lifecycle](../../../docs/security/key-lifecycle.md)
and [threat model](../../../docs/security/threat-model.md).

## Normative encoding rules

- The format version and key epoch are unsigned integer `1`.
- Integers are unsigned and big-endian.
- UUID inputs are parsed, then rendered as lowercase hyphenated 36-byte ASCII
  in AAD. Trip-key envelopes use the UUID's 16 RFC network-order bytes.
- JSON binary values use canonical padded RFC 4648 standard Base64. Alternate
  alphabets, missing padding, non-zero pad bits, whitespace, and trailing bytes
  are invalid.
- SHA-256 digests are exactly 32 raw bytes in binary structures.
- Runtime encoders accept closed objects: missing and unknown fields are
  invalid, and object property enumeration never chooses the wire order.
- No fallback algorithm, alternate field order, alternate endian convention,
  or compatibility parser exists in V1.

## Key hierarchy

Each logical asset has a fresh random 32-byte content root. Derive two 32-byte
stream keys with libsodium `crypto_kdf_derive_from_key`:

| Purpose        | Eight-byte KDF context | Subkey ID |
| -------------- | ---------------------- | --------: |
| Preview media  | `CRROLL01`             |         1 |
| Original media | `CRROLL01`             |         2 |

Derive the 32-byte manifest key from the epoch-1 trip key with the eight-byte
context `CRMANF01` and subkey ID `1`. The content root exists only in the
encrypted manifest. No nested key wrap, `wrappedContentKey`, or per-variant
wrapped key exists.

## Associated data

The same AAD byte string is supplied to every secretstream push or pull for one
media object. MIME, filename, dimensions, capture time, hashes, raw source IDs,
and source deduplication keys are not AAD.

### Media AAD: exactly 95 bytes

| Offset | Bytes | Value                                |
| -----: | ----: | ------------------------------------ |
|      0 |    14 | ASCII `CRROLL-AAD-V1\0`              |
|     14 |    36 | canonical trip UUID ASCII            |
|     50 |    36 | canonical asset UUID ASCII           |
|     86 |     1 | preview `1`, original `2`            |
|     87 |     4 | key epoch, uint32 BE, value `1`      |
|     91 |     4 | format version, uint32 BE, value `1` |

### Manifest AAD: exactly 94 bytes

| Offset | Bytes | Value                                |
| -----: | ----: | ------------------------------------ |
|      0 |    14 | ASCII `CRROLL-MAN-V1\0`              |
|     14 |    36 | canonical trip UUID ASCII            |
|     50 |    36 | canonical asset UUID ASCII           |
|     86 |     4 | key epoch, uint32 BE, value `1`      |
|     90 |     4 | format version, uint32 BE, value `1` |

## Media blob

Media uses libsodium `crypto_secretstream_xchacha20poly1305`: a 32-byte key,
24-byte random header, 17 bytes of per-message authentication overhead,
`TAG_MESSAGE = 0x00`, and `TAG_FINAL = 0x03`.

```text
media_blob_v1       := secretstream_header frame+
secretstream_header := 24 bytes
frame               := ciphertext_length ciphertext
ciphertext_length   := uint32 BE; includes the 17-byte authentication overhead
ciphertext           := exactly ciphertext_length secretstream bytes
```

The four-byte prefix is transport framing, not secretstream input. It is part
of the complete framed media blob checksum. A ciphertext frame is 17 through
262,161 bytes. There is no media magic, embedded UUID, MIME, total-length
field, or chunk count.

For plaintext size `P`:

```text
frameCount     = max(1, ceil(P / 262144))
ciphertextBytes = 24 + P + frameCount * (4 + 17)
```

- The plaintext target is 262,144 bytes (256 KiB).
- Every non-final frame is exactly 262,144 plaintext bytes and uses
  `TAG_MESSAGE`.
- The last frame contains 0 through 262,144 bytes and uses `TAG_FINAL`.
- Empty plaintext is one empty `TAG_FINAL` frame.
- An exact multiple marks its last full frame `TAG_FINAL`; it adds no empty
  frame.
- `PUSH`, `REKEY`, unknown tags, a short `TAG_MESSAGE`, an early or absent
  final tag, and any byte after `TAG_FINAL` are invalid.

| Plaintext bytes | Frames | Complete ciphertext bytes |
| --------------: | -----: | ------------------------: |
|               0 |      1 |                        45 |
|               1 |      1 |                        46 |
|         262,144 |      1 |                   262,189 |
|         262,145 |      2 |                   262,211 |

The plaintext SHA-256 covers the exact pre-encryption variant bytes. The
ciphertext SHA-256 covers the complete framed media blob: header, every length
prefix, and every ciphertext byte. `ciphertextBytes` describes those same
complete bytes. A reader verifies ciphertext length and hash, authenticates all
frames through exact EOF, requires `TAG_FINAL`, and finally verifies plaintext
SHA-256. Failure destroys the candidate plaintext.

## Manifest plaintext

```text
manifest_plaintext_v1 :=
  domain schema_version content_root
  captured_at_present captured_at_ms
  filename_length filename
  preview_descriptor original_descriptor
```

| Field                    |    Bytes | Rule                                                                     |
| ------------------------ | -------: | ------------------------------------------------------------------------ |
| Domain                   |        8 | ASCII `CRMANP1\0`                                                        |
| Schema version           |        4 | uint32 BE, exactly `1`                                                   |
| Content root             |       32 | random per-asset root                                                    |
| Capture present          |        1 | exactly `0` or `1`                                                       |
| Captured-at milliseconds |        8 | uint64 BE; zero iff absent, otherwise positive through `253402300799999` |
| Filename length          |        2 | uint16 BE; 0 through 255 UTF-8 bytes                                     |
| Filename                 | variable | exact declared bytes                                                     |
| Preview descriptor       | variable | variant `1`, first and exactly once                                      |
| Original descriptor      | variable | variant `2`, second and exactly once                                     |

A present filename is valid UTF-8, already NFC-normalized, and a display-only
basename. Slash, backslash, NUL, ASCII controls, and DEL are invalid. It is
never used as a destination path.

Each descriptor has this exact positional representation:

| Field              |    Bytes | Rule                                                        |
| ------------------ | -------: | ----------------------------------------------------------- |
| Variant code       |        1 | preview `1`, original `2`                                   |
| MIME length        |        1 | 3 through 127                                               |
| MIME               | variable | lowercase ASCII `type/subtype`, no whitespace or parameters |
| Pixel width        |        4 | positive uint32 BE                                          |
| Pixel height       |        4 | positive uint32 BE                                          |
| Plaintext bytes    |        8 | uint64 BE                                                   |
| Plaintext SHA-256  |       32 | raw digest                                                  |
| Ciphertext bytes   |        8 | uint64 BE, at least 45                                      |
| Ciphertext SHA-256 |       32 | raw digest of the complete media blob                       |

Allowed MIME token characters are lowercase `a-z`, `0-9`, `!`, `#`, `$`, `&`,
`^`, `_`, `.`, `+`, and `-`, with one slash between nonempty tokens. The fixed
descriptor cost is 90 bytes before MIME. The complete manifest plaintext is
241 through 744 bytes.

## Encrypted manifest

The manifest uses libsodium
`crypto_aead_xchacha20poly1305_ietf` combined mode:

```text
encrypted_manifest_v1 := nonce combined_ciphertext
nonce                  := fresh random 24 bytes
combined_ciphertext    := manifest_plaintext_v1 plus 16 authentication bytes
```

The key is the `CRMANF01` subkey, and the AAD is the exact 94-byte manifest AAD.
The decoded encrypted object is 281 through 784 bytes. The external format
version selects this parser; the authenticated plaintext also carries schema
version `1`. No trailing byte is accepted.

## Trip-key envelope

The envelope uses libsodium `crypto_box_seal` and `crypto_box_seal_open`. Its
plaintext is exactly 100 bytes and its anonymous sealed-box ciphertext is
exactly 148 bytes (200 canonical padded Base64 characters).

| Offset | Bytes | Value                                      |
| -----: | ----: | ------------------------------------------ |
|      0 |     8 | ASCII `CRTKENV1`                           |
|      8 |     4 | algorithm version, uint32 BE, `1`          |
|     12 |    16 | trip UUID network-order bytes              |
|     28 |     4 | key epoch, uint32 BE, `1`                  |
|     32 |    16 | sender device UUID bytes                   |
|     48 |    16 | recipient device UUID bytes                |
|     64 |     4 | recipient E2EE key version, uint32 BE, `1` |
|     68 |    32 | trip epoch key                             |

All inner context is checked before the 32-byte key is persisted. Anonymous
sealed boxes provide recipient confidentiality and ciphertext integrity, not
sender authentication. Consequently, a context-correct first-import envelope
can substitute a different trip key. The canonical substitution vector must
open to that different key and records this availability risk; every other
failure-designated mutation is rejected. An already-installed different trip
key is never replaced.

## Fail-closed and interoperability rules

Readers reject structural truncation or extension before cryptography where
possible; otherwise they reject authentication, semantic context, or final
checksum disagreement before exposing a saveable plaintext. Reordered,
duplicated, omitted, or cross-variant frames are invalid.

Only official libsodium APIs implement KDF, secretstream, AEAD, sealed boxes,
and SHA-256. Production entropy supplies content roots, headers, nonces, and
sealed-box ephemeral keys. Fixture-only deterministic generation is isolated
from every product build and never changes production RNG. There is no custom
cryptographic primitive, parser retry, silent version downgrade, or algorithm
fallback.

Committed vectors are immutable protocol truth. Verifiers read them without
network access, require a closed filename inventory and exact SHA-256 for every
binary, and generate mutations only in memory. TypeScript, Swift, and Kotlin
conformance readers must agree on these bytes before CON-002 is complete.
