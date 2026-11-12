import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../src/store/index.ts";

/** A store in a fresh temporary directory, removed by `cleanup`. */
export function tempStore(): {
  dir: string;
  store: Store;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "superdispatch-test-"));
  const store = openStore(dir);
  return {
    dir,
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const OPERATOR_TOKEN = "operator-token-for-tests";
export const OPERATOR_TOKEN_SHA256 = new Bun.CryptoHasher("sha256")
  .update(OPERATOR_TOKEN)
  .digest("hex");
