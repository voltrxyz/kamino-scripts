import "dotenv/config";
import * as fs from "fs";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  getAddressLookupTableAccounts,
  sendAndConfirmOptimisedTx,
  setupAddressLookupTable,
  setupTokenAccount,
} from "../utils/helper";
import { VoltrClient } from "@voltr/vault-sdk";
import {
  assetMintAddress,
  vaultAddress,
  assetTokenProgram,
  useLookupTable,
  lookupTableAddress,
} from "../../config/base";
import { ADAPTOR_PROGRAM_ID, DISCRIMINATOR } from "../constants/kamino";
import { kvaultAddress } from "../../config/kamino";
import { KVAULTS_PROGRAM_ID } from "@kamino-finance/klend-sdk";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

const initializeKVaultStrategy = async (
  connection: Connection,
  payerKp: Keypair,
  adminKp: Keypair,
  managerKp: Keypair,
  vault: PublicKey,
  vaultAssetMint: PublicKey,
  assetTokenProgram: PublicKey,
  adaptorProgram: PublicKey,
  kvault: PublicKey,
  kvaultsProgram: PublicKey,
  sharesTokenProgram: PublicKey,
  instructionDiscriminator: number[],
  lookupTableAddresses: string[] = []
) => {
  const vc = new VoltrClient(connection);

  const { vaultStrategyAuth } = vc.findVaultStrategyAddresses(vault, kvault);

  let transactionIxs: TransactionInstruction[] = [];

  const _vaultStrategyAssetAta = await setupTokenAccount(
    connection,
    managerKp.publicKey,
    vaultAssetMint,
    vaultStrategyAuth,
    transactionIxs,
    assetTokenProgram
  );

  const _managerAssetAta = await setupTokenAccount(
    connection,
    managerKp.publicKey,
    vaultAssetMint,
    managerKp.publicKey,
    transactionIxs,
    assetTokenProgram
  );

  const [sharesMint] = PublicKey.findProgramAddressSync(
    [Buffer.from("shares"), kvault.toBuffer()],
    kvaultsProgram
  );

  const _vaultStrategySharesAta = await setupTokenAccount(
    connection,
    managerKp.publicKey,
    sharesMint,
    vaultStrategyAuth,
    transactionIxs,
    sharesTokenProgram
  );

  const createInitializeStrategyIx = await vc.createInitializeStrategyIx(
    {
      instructionDiscriminator: Buffer.from(instructionDiscriminator),
    },
    {
      payer: payerKp.publicKey,
      manager: managerKp.publicKey,
      vault,
      strategy: kvault,
      remainingAccounts: [],
      adaptorProgram,
    }
  );

  transactionIxs.push(createInitializeStrategyIx);

  const lookupTableAccounts = lookupTableAddresses
    ? await getAddressLookupTableAccounts(lookupTableAddresses, connection)
    : [];

  const txSig = await sendAndConfirmOptimisedTx(
    transactionIxs,
    process.env.HELIUS_RPC_URL!,
    managerKp,
    [],
    lookupTableAccounts
  );
  console.log("Kvault strategy initialized with signature:", txSig);

  if (useLookupTable) {
    const transactionIxs1: TransactionInstruction[] = [];

    const lut = await setupAddressLookupTable(
      connection,
      payerKp.publicKey,
      adminKp.publicKey,
      [
        ...new Set(
          transactionIxs.flatMap((ix) =>
            ix.keys.map((k) => k.pubkey.toBase58())
          )
        ),
      ],
      transactionIxs1,
      new PublicKey(lookupTableAddress)
    );

    const txSig1 = await sendAndConfirmOptimisedTx(
      transactionIxs1,
      process.env.HELIUS_RPC_URL!,
      payerKp,
      [adminKp],
      undefined,
      50_000
    );

    console.log(`LUT updated with signature: ${txSig1}`);
  }
};

const main = async () => {
  const payerKpFile = fs.readFileSync(process.env.ADMIN_FILE_PATH!, "utf-8");
  const payerKpData = JSON.parse(payerKpFile);
  const payerSecret = Uint8Array.from(payerKpData);
  const payerKp = Keypair.fromSecretKey(payerSecret);

  await initializeKVaultStrategy(
    new Connection(process.env.HELIUS_RPC_URL!),
    payerKp,
    payerKp,
    payerKp,
    new PublicKey(vaultAddress),
    new PublicKey(assetMintAddress),
    new PublicKey(assetTokenProgram),
    new PublicKey(ADAPTOR_PROGRAM_ID),
    new PublicKey(kvaultAddress),
    new PublicKey(KVAULTS_PROGRAM_ID),
    TOKEN_PROGRAM_ID,
    DISCRIMINATOR.INITIALIZE_VAULT
  );
};

main();
