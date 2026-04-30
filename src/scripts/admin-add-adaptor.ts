import "dotenv/config";
import * as fs from "fs";
import {
  address,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  type Address,
  type Instruction,
} from "@solana/kit";
import { getAddAdaptorInstructionAsync } from "@voltr/vault-sdk";
import {
  sendAndConfirmOptimisedTx,
  setupAddressLookupTable,
} from "../utils/helper";
import {
  lookupTableAddress,
  useLookupTable,
  vaultAddress,
} from "../../config/base";
import { ADAPTOR_PROGRAM_ID } from "../constants/kamino";

const main = async () => {
  const payerSecret = Uint8Array.from(
    JSON.parse(fs.readFileSync(process.env.ADMIN_FILE_PATH!, "utf-8"))
  );
  const payerSigner = await createKeyPairSignerFromBytes(payerSecret);

  const addAdaptorIx = await getAddAdaptorInstructionAsync({
    payer: payerSigner,
    admin: payerSigner,
    vault: vaultAddress,
    adaptorProgram: address(ADAPTOR_PROGRAM_ID),
  });

  const txSig0 = await sendAndConfirmOptimisedTx(
    [addAdaptorIx],
    process.env.HELIUS_RPC_URL!,
    payerSigner
  );
  console.log(`Adaptor added to vault with signature: ${txSig0}`);

  if (useLookupTable) {
    const transactionIxs1: Instruction[] = [];
    const ixAddresses: Address[] = Array.from(
      new Set((addAdaptorIx.accounts ?? []).map((a) => a.address as Address))
    );

    await setupAddressLookupTable(
      createSolanaRpc(process.env.HELIUS_RPC_URL!),
      payerSigner,
      payerSigner,
      ixAddresses,
      transactionIxs1,
      lookupTableAddress
    );

    const txSig1 = await sendAndConfirmOptimisedTx(
      transactionIxs1,
      process.env.HELIUS_RPC_URL!,
      payerSigner,
      undefined,
      50_000
    );

    console.log(`LUT updated with signature: ${txSig1}`);
  }
};

main();
