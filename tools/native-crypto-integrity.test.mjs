import assert from "node:assert/strict";
import test from "node:test";

import { verifyNativeCryptoIntegrity } from "./native-crypto-integrity.mjs";

test("native production crypto artifacts match the locked reviewed inventory and bindings", async () => {
  const result = await verifyNativeCryptoIntegrity(process.cwd());

  assert.deepEqual(result, {
    appleFileCount: 791,
    appleInventorySha256:
      "d63396012090ae91657484d892cae9b83aeaeb1202e4ea52ef563a21a68dce5b",
    appleMacosSliceSha256:
      "9e00d236b5fc294f48825edbc1ca8971dc418363dae8cc7787004d63454ed563",
    appleInfoPlistSha256:
      "b33b6160100ac0307b351cba8056d347db80df62b2782624d9e06a86407dbcbd",
    appleLicenseSha256:
      "65bdb1ccfab986d20315fe5384c09c9eadabaa7128eac584e1daf6bc558346d3",
    lazysodiumAndroidSha256:
      "b5378c1d9db2573d61b304e89cf83db187a05c3e4ff081d9b2ef3d0bb00ca314",
    lazysodiumClassesJarSha256:
      "3540e71bbad48ae40f54c76fec6e9d3fed43c4e823bd0aedd5ed1d1cb1c09dbb",
    lazysodiumAarMetadataSha256:
      "9cc8517bbdf06d879f57a2cfd6f8c6914e48800d443421cd850971945f98e7b2",
    lazysodiumLicenseSha256:
      "4b89d4518bd135ab4ee154a7bce722246b57a98c3d7efc1a09409898160c2bd1",
    jnaAndroidSha256:
      "4dbeffffa665d97ad5aa7eee297531d3c841a86716ab7f774fd6956422b3cf38",
    jnaClassesJarSha256:
      "d139557765f1668044aaf88ca258b319cacf73748b58fdb7b95a7fc4011d4129",
    jnaLicenseSha256:
      "07c938b23950ab7d47a24ef35f9f5da3a05ae164278dc959ad6994135ed59ff1",
    jnaSelectedLicenseSha256:
      "0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594",
  });
});
