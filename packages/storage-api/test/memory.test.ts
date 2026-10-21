import { createMemoryStorage } from "../src/index.ts";
import { describeBlobContract, describeStorageContract } from "../src/contract.ts";

describeStorageContract("memory", async () => createMemoryStorage());
describeBlobContract("memory", async () => ({ blobs: createMemoryStorage().blobs }));
