import "dotenv/config";
import * as fs from "fs";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import { VoltrClient } from "@voltr/vault-sdk";
import {
  sendAndConfirmOptimisedTx,
  setupAddressLookupTable,
} from "../utils/helper";
import {
  lookupTableAddress,
  useLookupTable,
  vaultAddress,
} from "../../config/base";
import { kvaultAddress } from "../../config/kamino";
import { ADAPTOR_PROGRAM_ID, DISCRIMINATOR } from "../constants/kamino";

const initializeDirectWithdrawStrategy = async (
  connection: Connection,
  payerKp: Keypair,
  adminKp: Keypair,
  vault: PublicKey,
  strategy: PublicKey,
  adaptorProgram: PublicKey,
  useLookupTable: boolean,
  lookupTableAddress: PublicKey,
  instructionDiscriminator: Buffer | null = null,
  additionalArgs: Buffer | null = null,
  allowUserArgs: boolean = false
) => {
  const vc = new VoltrClient(connection);

  let transactionIxs: TransactionInstruction[] = [];

  const createInitializeDirectWithdrawIx =
    await vc.createInitializeDirectWithdrawStrategyIx(
      {
        instructionDiscriminator,
        additionalArgs,
        allowUserArgs,
      },
      {
        payer: payerKp.publicKey,
        admin: adminKp.publicKey,
        vault,
        strategy,
        adaptorProgram,
      }
    );

  transactionIxs.push(createInitializeDirectWithdrawIx);

  const txSig = await sendAndConfirmOptimisedTx(
    transactionIxs,
    process.env.HELIUS_RPC_URL!,
    payerKp,
    [adminKp],
    undefined
  );
  console.log(
    "Kvault direct withdraw strategy initialized with signature:",
    txSig
  );

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
  const adminKpFile = fs.readFileSync(process.env.ADMIN_FILE_PATH!, "utf-8");
  const adminKpData = JSON.parse(adminKpFile);
  const adminSecret = Uint8Array.from(adminKpData);
  const adminKp = Keypair.fromSecretKey(adminSecret);

  await initializeDirectWithdrawStrategy(
    new Connection(process.env.HELIUS_RPC_URL!),
    payerKp,
    adminKp,
    new PublicKey(vaultAddress),
    new PublicKey(kvaultAddress),
    new PublicKey(ADAPTOR_PROGRAM_ID),
    useLookupTable,
    new PublicKey(lookupTableAddress),
    Buffer.from(DISCRIMINATOR.WITHDRAW_VAULT),
    null,
    false
  );
};

main();
