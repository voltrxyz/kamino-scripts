import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type AccountMeta as KitAccountMeta,
  type Address,
  type AddressesByLookupTableAddress,
  type Blockhash,
  type Instruction,
  type KeyPairSigner,
  type Signature,
  type TransactionSigner,
} from "@solana/kit";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
} from "@solana-program/token";
import {
  fetchAddressLookupTable,
  getExtendLookupTableInstruction,
} from "@solana-program/address-lookup-table";
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

type SolanaRpc = ReturnType<typeof createSolanaRpc>;

const isLegacyConnection = (value: unknown): value is Connection =>
  value instanceof Connection;

const isLegacyKeypair = (value: unknown): value is Keypair =>
  value instanceof Keypair;

export async function sendAndConfirmOptimisedTx(
  instructions: Instruction[],
  heliusRpcUrl: string,
  payerSigner: KeyPairSigner,
  addressesByLookupTable?: AddressesByLookupTableAddress,
  computeUnitLimit?: number | null
): Promise<Signature>;
export async function sendAndConfirmOptimisedTx(
  instructions: TransactionInstruction[],
  heliusRpcUrl: string,
  payerSigner: Keypair,
  additionalSigners?: Keypair[],
  lookupTableAccounts?: AddressLookupTableAccount[],
  computeUnitLimit?: number | null
): Promise<string>;
export async function sendAndConfirmOptimisedTx(
  instructions: Instruction[] | TransactionInstruction[],
  heliusRpcUrl: string,
  payerSigner: KeyPairSigner | Keypair,
  arg4: AddressesByLookupTableAddress | Keypair[] = {},
  arg5: number | null | AddressLookupTableAccount[] = null,
  arg6: number | null = null
): Promise<Signature | string> {
  if (isLegacyKeypair(payerSigner)) {
    return sendAndConfirmLegacyTx(
      instructions as TransactionInstruction[],
      heliusRpcUrl,
      payerSigner,
      Array.isArray(arg4) ? arg4 : [],
      Array.isArray(arg5) ? arg5 : [],
      arg6
    );
  }

  return sendAndConfirmKitTx(
    instructions as Instruction[],
    heliusRpcUrl,
    payerSigner,
    Array.isArray(arg4) ? {} : arg4,
    typeof arg5 === "number" || arg5 === null ? arg5 : null
  );
}

const sendAndConfirmKitTx = async (
  instructions: Instruction[],
  heliusRpcUrl: string,
  payerSigner: KeyPairSigner,
  addressesByLookupTable: AddressesByLookupTableAddress = {},
  computeUnitLimit: number | null = null
): Promise<Signature> => {
  const rpc = createSolanaRpc(heliusRpcUrl);

  const buildMessage = async (
    ixs: Instruction[],
    blockhash: { blockhash: Blockhash; lastValidBlockHeight: bigint }
  ) => {
    let message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payerSigner, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(ixs, m)
    );
    if (Object.keys(addressesByLookupTable).length > 0) {
      message = compressTransactionMessageUsingAddressLookupTables(
        message,
        addressesByLookupTable
      ) as typeof message;
    }
    return message;
  };

  let optimalCUs: number;
  if (computeUnitLimit) {
    optimalCUs = computeUnitLimit;
  } else {
    const { value: latest } = await rpc.getLatestBlockhash().send();
    const simIxs: Instruction[] = [
      getSetComputeUnitLimitInstruction({ units: 1_400_000 }),
      ...instructions,
    ];
    const simMessage = await buildMessage(simIxs, latest);
    const simSigned = await signTransactionMessageWithSigners(simMessage);
    const wireSim = getBase64EncodedWireTransaction(simSigned);

    const sim = await rpc
      .simulateTransaction(wireSim, {
        encoding: "base64",
        replaceRecentBlockhash: true,
        sigVerify: false,
      })
      .send();

    const requiredCUs = sim.value.unitsConsumed;
    if (requiredCUs == null) {
      throw new Error("Failed to get required CUs");
    }
    optimalCUs = Math.ceil(Number(requiredCUs) * 1.1);
  }

  const cuLimitIx = getSetComputeUnitLimitInstruction({ units: optimalCUs });

  const { value: feeBlockhash } = await rpc.getLatestBlockhash().send();
  const feeEstMessage = await buildMessage(
    [...instructions, cuLimitIx],
    feeBlockhash
  );
  const feeEstSigned = await signTransactionMessageWithSigners(feeEstMessage);
  const wireFeeEst = getBase64EncodedWireTransaction(feeEstSigned);

  const feeForMessage = await rpc
    .getFeeForMessage(wireFeeEst.replace("=", "") as never, {
      commitment: "confirmed",
    })
    .send();
  const feeLamports = feeForMessage.value ?? 0n;
  const cuPriceMicroLamports = Math.max(
    1,
    Math.ceil((Number(feeLamports) * 1_000_000) / optimalCUs)
  );
  const cuPriceIx = getSetComputeUnitPriceInstruction({
    microLamports: BigInt(cuPriceMicroLamports),
  });

  const { value: sendBlockhash } = await rpc.getLatestBlockhash().send();
  const finalMessage = await buildMessage(
    [...instructions, cuLimitIx, cuPriceIx],
    sendBlockhash
  );
  const signed = await signTransactionMessageWithSigners(finalMessage);
  const wire = getBase64EncodedWireTransaction(signed);
  const signature = getSignatureFromTransaction(signed);

  await rpc
    .sendTransaction(wire, {
      encoding: "base64",
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 5n,
    })
    .send();

  await confirmKitSignature(rpc, signature, sendBlockhash.lastValidBlockHeight);

  return signature;
};

const sendAndConfirmLegacyTx = async (
  instructions: TransactionInstruction[],
  heliusRpcUrl: string,
  payerSigner: Keypair,
  additionalSigners: Keypair[] = [],
  lookupTableAccounts: AddressLookupTableAccount[] = [],
  computeUnitLimit: number | null = null
): Promise<string> => {
  const connection = new Connection(heliusRpcUrl, "confirmed");
  const computeIxs = computeUnitLimit
    ? [ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit })]
    : [];
  const latest = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: payerSigner.publicKey,
    recentBlockhash: latest.blockhash,
    instructions: [...computeIxs, ...instructions],
  }).compileToV0Message(lookupTableAccounts);
  const tx = new VersionedTransaction(message);
  tx.sign([payerSigner, ...additionalSigners]);
  const signature = await connection.sendTransaction(tx, {
    skipPreflight: false,
    maxRetries: 5,
  });
  await connection.confirmTransaction(
    {
      signature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    "confirmed"
  );
  return signature;
};

const confirmKitSignature = async (
  rpc: SolanaRpc,
  signature: Signature,
  lastValidBlockHeight: bigint
): Promise<void> => {
  while (true) {
    const { value } = await rpc
      .getSignatureStatuses([signature], { searchTransactionHistory: true })
      .send();
    const status = value[0];
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      if (status.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
      }
      return;
    }
    const blockHeight = await rpc.getBlockHeight().send();
    if (blockHeight > lastValidBlockHeight) {
      throw new Error(
        `Transaction expired: ${signature} not confirmed before lastValidBlockHeight ${lastValidBlockHeight}`
      );
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
};

export async function setupTokenAccount(
  rpc: SolanaRpc,
  payerSigner: TransactionSigner,
  mint: Address,
  owner: Address,
  txIxs: Instruction[],
  programAddress?: Address
): Promise<Address>;
export async function setupTokenAccount(
  connection: Connection,
  payer: PublicKey,
  mint: PublicKey,
  owner: PublicKey,
  txIxs: TransactionInstruction[],
  programAddress?: PublicKey
): Promise<PublicKey>;
export async function setupTokenAccount(
  rpcOrConnection: SolanaRpc | Connection,
  payerOrSigner: TransactionSigner | PublicKey,
  mint: Address | PublicKey,
  owner: Address | PublicKey,
  txIxs: Instruction[] | TransactionInstruction[],
  programAddress: Address | PublicKey = TOKEN_PROGRAM_ADDRESS
): Promise<Address | PublicKey> {
  if (isLegacyConnection(rpcOrConnection)) {
    const ata = getAssociatedTokenAddressSync(
      mint as PublicKey,
      owner as PublicKey,
      true,
      programAddress as PublicKey
    );
    const accountInfo = await rpcOrConnection.getAccountInfo(ata);
    if (!accountInfo) {
      (txIxs as TransactionInstruction[]).push(
        createAssociatedTokenAccountIdempotentInstruction(
          payerOrSigner as PublicKey,
          ata,
          owner as PublicKey,
          mint as PublicKey,
          programAddress as PublicKey
        )
      );
    }
    return ata;
  }

  const [ata] = await findAssociatedTokenPda({
    owner: owner as Address,
    mint: mint as Address,
    tokenProgram: programAddress as Address,
  });

  const accountInfo = await rpcOrConnection.getAccountInfo(ata).send();
  if (!accountInfo.value) {
    const ix = await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: payerOrSigner as TransactionSigner,
      owner: owner as Address,
      mint: mint as Address,
      tokenProgram: programAddress as Address,
    });
    (txIxs as Instruction[]).push(ix);
  }

  return ata;
}

export async function setupAddressLookupTable(
  rpc: SolanaRpc,
  payerSigner: TransactionSigner,
  authoritySigner: TransactionSigner,
  addresses: Address[],
  txIxs: Instruction[],
  lookupTable: Address
): Promise<Address>;
export async function setupAddressLookupTable(
  connection: Connection,
  payer: PublicKey,
  authority: PublicKey,
  addresses: string[],
  txIxs: TransactionInstruction[],
  lookupTable: PublicKey
): Promise<PublicKey>;
export async function setupAddressLookupTable(
  rpcOrConnection: SolanaRpc | Connection,
  payerOrSigner: TransactionSigner | PublicKey,
  authorityOrSigner: TransactionSigner | PublicKey,
  addresses: Address[] | string[],
  txIxs: Instruction[] | TransactionInstruction[],
  lookupTable: Address | PublicKey
): Promise<Address | PublicKey> {
  if (isLegacyConnection(rpcOrConnection)) {
    const lutAccount = await rpcOrConnection
      .getAddressLookupTable(lookupTable as PublicKey)
      .then((res) => res.value);
    if (!lutAccount) {
      throw new Error("Lookup table not found");
    }
    const existing = new Set(lutAccount.state.addresses.map((a) => a.toBase58()));
    const filtered = (addresses as string[])
      .filter((a) => !existing.has(a))
      .map((a) => new PublicKey(a));
    if (filtered.length > 0) {
      (txIxs as TransactionInstruction[]).push(
        AddressLookupTableProgram.extendLookupTable({
          lookupTable: lookupTable as PublicKey,
          authority: authorityOrSigner as PublicKey,
          payer: payerOrSigner as PublicKey,
          addresses: filtered,
        })
      );
    }
    return lookupTable as PublicKey;
  }

  const lutAccount = await fetchAddressLookupTable(
    rpcOrConnection,
    lookupTable as Address
  );
  const existing = new Set<string>(lutAccount.data.addresses);
  const filtered = (addresses as Address[]).filter((a) => !existing.has(a));
  if (filtered.length > 0) {
    (txIxs as Instruction[]).push(
      getExtendLookupTableInstruction({
        address: lookupTable as Address,
        authority: authorityOrSigner as TransactionSigner,
        payer: payerOrSigner as TransactionSigner,
        addresses: filtered,
      })
    );
  }
  return lookupTable as Address;
}

export const getAddressesByLookupTable = async (
  keys: Address[],
  rpc: SolanaRpc
): Promise<AddressesByLookupTableAddress> => {
  const result: AddressesByLookupTableAddress = {};
  for (const key of keys) {
    const lut = await fetchAddressLookupTable(rpc, key);
    result[key] = [...lut.data.addresses];
  }
  return result;
};

export const getAddressLookupTableAccounts = async (
  keys: string[],
  connection: Connection
): Promise<AddressLookupTableAccount[]> => {
  const results = await Promise.all(
    keys.map((key) =>
      connection.getAddressLookupTable(new PublicKey(key)).then((res) => res.value)
    )
  );
  return results.filter(
    (value): value is AddressLookupTableAccount => value !== null
  );
};

export const createKitSignerFromKeypair = async (
  keypair: Keypair
): Promise<KeyPairSigner> => {
  return createKeyPairSignerFromBytes(keypair.secretKey);
};

export const publicKeyToAddress = (value: PublicKey | string): Address =>
  address(typeof value === "string" ? value : value.toBase58());

export const kitAccountMetaFromWeb3 = (
  meta: import("@solana/web3.js").AccountMeta
): KitAccountMeta<Address> => ({
  address: publicKeyToAddress(meta.pubkey),
  role: meta.isWritable
    ? meta.isSigner
      ? AccountRole.WRITABLE_SIGNER
      : AccountRole.WRITABLE
    : meta.isSigner
      ? AccountRole.READONLY_SIGNER
      : AccountRole.READONLY,
});

export const appendRemainingAccounts = <
  T extends { accounts?: readonly KitAccountMeta<Address>[] }
>(
  instruction: T,
  remainingAccounts: import("@solana/web3.js").AccountMeta[] = []
): T => ({
  ...instruction,
  accounts: [
    ...(instruction.accounts ?? []),
    ...remainingAccounts.map(kitAccountMetaFromWeb3),
  ],
});

export const kitInstructionToWeb3 = (
  instruction: Instruction
): TransactionInstruction =>
  new TransactionInstruction({
    programId: new PublicKey(instruction.programAddress),
    keys: (instruction.accounts ?? []).map((account) => ({
      pubkey: new PublicKey(account.address),
      isSigner:
        account.role === AccountRole.READONLY_SIGNER ||
        account.role === AccountRole.WRITABLE_SIGNER,
      isWritable:
        account.role === AccountRole.WRITABLE ||
        account.role === AccountRole.WRITABLE_SIGNER,
    })),
    data: Buffer.from(instruction.data ?? []),
  });

export {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ID,
};
