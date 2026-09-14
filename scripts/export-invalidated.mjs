import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";

const output = process.argv[2];
if (!output) throw new Error("usage: node scripts/export-invalidated.mjs <output.json>");
const config = JSON.parse(readFileSync(`${process.env.HOME}/.hindsight/coding-agent.json`, "utf8"));
const headers = { Authorization: `Bearer ${config.apiToken}` };
async function get(path) {
  const response = await fetch(`${config.apiUrl}${path}`, { headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`);
  return response.json();
}
const listed = await get("/v1/default/banks?limit=200");
const banks = [];
for (const bank of listed.banks) {
  const items = [];
  let offset = 0;
  while (true) {
    const page = await get(`/v1/default/banks/${encodeURIComponent(bank.bank_id)}/memories/list?state=invalidated&limit=100&offset=${offset}`);
    items.push(...page.items);
    offset += page.items.length;
    if (offset >= page.total || page.items.length === 0) break;
  }
  banks.push({ bankId: bank.bank_id, total: items.length, items });
}
await writeFile(output, `${JSON.stringify({ version: 1, createdAt: new Date().toISOString(), banks }, null, 2)}\n`, { mode: 0o600 });
console.log(banks.map((bank) => `${bank.bankId}=${bank.total}`).join(" "));
