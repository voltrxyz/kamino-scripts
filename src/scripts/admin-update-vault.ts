import "dotenv/config";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import { sendAndConfirmOptimisedTx } from "../utils/helper";
import { VoltrClient } from "@voltr/vault-sdk";
import { vaultAddress, vaultConfig } from "../../config/base";

const adminKpFile = fs.readFileSync(process.env.ADMIN_FILE_PATH!, "utf-8");
const adminKpData = JSON.parse(adminKpFile);
const adminSecret = Uint8Array.from(adminKpData);
const adminKp = Keypair.fromSecretKey(adminSecret);
const admin = adminKp.publicKey;

const vault = new PublicKey(vaultAddress);

const connection = new Connection(process.env.HELIUS_RPC_URL!);
const vc = new VoltrClient(connection);

/**
 * @deprecated Since version 1.0.14
 * This script uses the deprecated createUpdateVaultIx method.
 * Use admin-update-vault-config.ts instead for granular config updates.
 * This will be removed in a future version.
 */
const updateVaultHandler = async () => {
  console.warn(
    "⚠️  WARNING: This script uses a deprecated method (createUpdateVaultIx). Please use admin-update-vault-config.ts for granular config updates."
  );

  const createUpdateVaultIx = await vc.createUpdateVaultIx(vaultConfig, {
    vault,
    admin,
  });

  const txSig = await sendAndConfirmOptimisedTx(
    [createUpdateVaultIx],
    process.env.HELIUS_RPC_URL!,
    adminKp
  );

  console.log(`Vault updated with signature: ${txSig}`);
};

const main = async () => {
  await updateVaultHandler();
};

main();
