import { expect, test } from "bun:test";
import { verifyDelivery } from "@superjackfruitlabs/treaty-cloudevents";
import { SCHEMA_BASE } from "@superjackfruitlabs/treaty-event-schemas";

// The two treaty packages the relay delivery route is built on, at the versions package.json
// pins: the relay's delivery signature, and the catalogue of event schemas.
test("the treaty contracts resolve", () => {
  expect(typeof verifyDelivery).toBe("function");
  expect(SCHEMA_BASE).toStartWith("https://");
});
