import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyDelivery } from "@superjackfruitlabs/treaty-cloudevents";
import { readManifest } from "@superjackfruitlabs/treaty-contracts/node";
import { SCHEMA_BASE } from "@superjackfruitlabs/treaty-event-schemas";
import { at, record } from "./helpers.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const json = (path: string): unknown =>
  JSON.parse(readFileSync(join(ROOT, path), "utf8"));

// The two treaty packages the relay delivery route is built on, at the versions package.json
// pins: the relay's delivery signature, and the catalogue of event schemas.
test("the treaty contracts resolve", () => {
  expect(typeof verifyDelivery).toBe("function");
  expect(SCHEMA_BASE).toStartWith("https://");
});

// One treaty release: treaty.json's pin is every treaty package's pin and the installed data's
// release, so `treaty verify` and the sources' validators read the same contracts.
test("every treaty package is pinned to treaty.json's release, and that release is installed", () => {
  const pin = at(json("treaty.json"), "treaty");
  const deps = record(at(json("apps/dispatch/package.json"), "dependencies"));
  const treatyPins = Object.entries(deps).filter(([name]) =>
    name.startsWith("@superjackfruitlabs/treaty-"),
  );
  expect(treatyPins.length).toBe(3);
  for (const [name, version] of treatyPins)
    expect({ name, version }).toEqual({ name, version: pin });
  expect(readManifest().treaty).toBe(String(pin));
});
