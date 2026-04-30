import "dotenv/config";
import * as fs from "fs";
import { KVAULTS_PROGRAM_ID } from "@kamino-finance/klend-sdk";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  address,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  type Address,
  type Instruction,
} from "@solana/kit";
import { PublicKey } from "@solana/web3.js";
import {
  findVaultStrategyAuthPda,
  getInitializeStrategyInstructionAsync,
} from "@voltr/vault-sdk";
import {
  getAddressesByLookupTable,
  publicKeyToAddress,
  sendAndConfirmOptimisedTx,
  setupAddressLookupTable,
  setupTokenAccount,
} from "../utils/helper";
import {
  assetMintAddress,
  assetTokenProgram,
  lookupTableAddress,
  useLookupTable,
  vaultAddress,
} from "../../config/base";
import { kvaultAddress } from "../../config/kamino";
import { ADAPTOR_PROGRAM_ID, DISCRIMINATOR } from "../constants/kamino";

const main = async () => {
  const payerSecret = Uint8Array.from(
    JSON.parse(fs.readFileSync(process.env.ADMIN_FILE_PATH!, "utf-8"))
  );
  const payerSigner = await createKeyPairSignerFromBytes(payerSecret);
  const rpc = createSolanaRpc(process.env.HELIUS_RPC_URL!);

  const kvaultPk = new PublicKey(kvaultAddress);
  const kvaultsProgramPk = new PublicKey(KVAULTS_PROGRAM_ID);
  const strategy = publicKeyToAddress(kvaultPk);
  const [vaultStrategyAuth] = await findVaultStrategyAuthPda({
    vault: vaultAddress,
    strategy,
  });

  const transactionIxs: Instruction[] = [];

  await setupTokenAccount(
    rpc,
    payerSigner,
    assetMintAddress,
    vaultStrategyAuth,
    transactionIxs,
    assetTokenProgram
  );

  await setupTokenAccount(
    rpc,
    payerSigner,
    assetMintAddress,
    payerSigner.address,
    transactionIxs,
    assetTokenProgram
  );

  const [sharesMint] = PublicKey.findProgramAddressSync(
    [Buffer.from("shares"), kvaultPk.toBuffer()],
    kvaultsProgramPk
  );

  await setupTokenAccount(
    rpc,
    payerSigner,
    publicKeyToAddress(sharesMint),
    vaultStrategyAuth,
    transactionIxs,
    publicKeyToAddress(TOKEN_PROGRAM_ID)
  );

  const initializeStrategyIx = await getInitializeStrategyInstructionAsync({
    payer: payerSigner,
    manager: payerSigner,
    vault: vaultAddress,
    strategy,
    adaptorProgram: address(ADAPTOR_PROGRAM_ID),
    instructionDiscriminator: new Uint8Array(DISCRIMINATOR.INITIALIZE_VAULT),
    additionalArgs: null,
  });

  transactionIxs.push(initializeStrategyIx);

  const lookupTables =
    useLookupTable && lookupTableAddress
      ? await getAddressesByLookupTable([lookupTableAddress], rpc)
      : {};

  const txSig = await sendAndConfirmOptimisedTx(
    transactionIxs,
    process.env.HELIUS_RPC_URL!,
    payerSigner,
    lookupTables
  );
  console.log("Kvault strategy initialized with signature:", txSig);

  if (useLookupTable && lookupTableAddress) {
    const lutIxs: Instruction[] = [];
    const ixAddresses: Address[] = Array.from(
      new Set((initializeStrategyIx.accounts ?? []).map((a) => a.address as Address))
    );

    await setupAddressLookupTable(
      rpc,
      payerSigner,
      payerSigner,
      ixAddresses,
      lutIxs,
      lookupTableAddress
    );

    const txSig1 = await sendAndConfirmOptimisedTx(
      lutIxs,
      process.env.HELIUS_RPC_URL!,
      payerSigner,
      undefined,
      50_000
    );

    console.log(`LUT updated with signature: ${txSig1}`);
  }
};

main();
