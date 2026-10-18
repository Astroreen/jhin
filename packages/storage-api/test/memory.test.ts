import { createMemoryStorage } from "../src/index.ts";
import { describeStorageContract } from "../src/contract.ts";

describeStorageContract("memory", async () => createMemoryStorage());
