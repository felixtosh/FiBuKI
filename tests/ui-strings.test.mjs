import test from "node:test";
import assert from "node:assert/strict";
import { countHardcodedStrings, compareToBaseline } from "../scripts/check-ui-strings.mjs";

test("counts JSX text and user-facing string attributes", () => {
  const src = `
    <Card>
      <CardTitle>Sign-in Methods</CardTitle>
      <Input placeholder="Your email" aria-label="Email" />
      <Button title='Delete'>Löschen</Button>
    </Card>`;
  assert.equal(countHardcodedStrings(src), 5);
});

test("ignores translated text, expressions, punctuation and non-UI attributes", () => {
  const src = `
    <Card className="mb-6" data-testid="card">
      <CardTitle>{t("title")}</CardTitle>
      <span>{count} / {total}</span>
      <span> - </span>
      <Icon className="h-4 w-4" />
    </Card>`;
  assert.equal(countHardcodedStrings(src), 0);
});

test("a file may lose strings but never gain them, and a new file starts at zero", () => {
  const baseline = { "a.tsx": 3, "b.tsx": 1 };
  assert.deepEqual(compareToBaseline({ "a.tsx": 2, "b.tsx": 1 }, baseline), []);
  assert.deepEqual(compareToBaseline({ "a.tsx": 4 }, baseline), [
    { file: "a.tsx", count: 4, allowed: 3 },
  ]);
  assert.deepEqual(compareToBaseline({ "new.tsx": 1 }, baseline), [
    { file: "new.tsx", count: 1, allowed: 0 },
  ]);
});
