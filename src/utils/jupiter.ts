import {
  AccountMeta,
  AddressLookupTableAccount,
  Connection,
  PublicKey,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { getAddressLookupTableAccounts } from "./helper";

const JUP_ENDPOINT = "https://lite-api.jup.ag/swap/v1";

export async function setupJupiterSwap(
  connection: Connection,
  swapAmount: BN,
  vaultStrategyAuth: PublicKey,
  inputMintAddress: PublicKey,
  outputMintAddress: PublicKey,
  slippageBps: number = 50,
  maxAccounts: number = 18
): Promise<{
  jupiterSwapAddressLookupTableAccounts: AddressLookupTableAccount[];
  jupiterSwapData: Buffer;
  jupiterSwapAccountMetas: AccountMeta[];
}> {
  try {
    // Get Jupiter quote
    const jupQuoteResponse = await (
      await fetch(
        `${JUP_ENDPOINT}/quote?inputMint=` +
          `${inputMintAddress.toBase58()}` +
          `&outputMint=` +
          `${outputMintAddress.toBase58()}` +
          `&amount=` +
          `${swapAmount.toString()}` +
          `&slippageBps=` +
          `${slippageBps}` +
          `&maxAccounts=` +
          `${maxAccounts}`
      )
    ).json();

    // Get Jupiter swap instructions
    const instructions = await (
      await fetch(`${JUP_ENDPOINT}/swap-instructions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          quoteResponse: jupQuoteResponse,
          userPublicKey: vaultStrategyAuth.toBase58(),
        }),
      })
    ).json();

    if (instructions.error) {
      throw new Error("Failed to get swap instructions: " + instructions.error);
    }

    // tokenLedgerInstruction is only present in withdrawals
    const {
      swapInstruction: swapInstructionPayload,
      addressLookupTableAddresses,
    } = instructions;

    // Get address lookup table accounts
    const jupiterSwapAddressLookupTableAccounts =
      await getAddressLookupTableAccounts(
        [...addressLookupTableAddresses],
        connection
      );

    const jupiterSwapAccountMetas = [
      {
        pubkey: new PublicKey(swapInstructionPayload.programId),
        isSigner: false,
        isWritable: false,
      },
      ...swapInstructionPayload.accounts.map((key: any) => ({
        pubkey: new PublicKey(key.pubkey),
        isSigner: false,
        isWritable: key.isWritable,
      })),
    ];

    const jupiterSwapData = Buffer.from(swapInstructionPayload.data, "base64");

    return {
      jupiterSwapAddressLookupTableAccounts,
      jupiterSwapData,
      jupiterSwapAccountMetas,
    };
  } catch (error) {
    console.error("Error setting up Jupiter swap:", error);
    throw error;
  }
}
