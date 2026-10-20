import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { c4MachineShape, parseC4SpotPrices, rankRegions, SpotPriceBook } from "../src/sandbox/provisioner/pricing.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/billing-compute-skus.json", import.meta.url), "utf8")).skus;
const dir = mkdtempSync(join(tmpdir(), "cgm-pricing-"));
after(() => rmSync(dir, { recursive: true, force: true }));

describe("C4 spot pricing", () => {
    it("maps only C4 machine types to shapes", () => {
        assert.deepEqual(c4MachineShape("c4-standard-2"), { vcpus: 2, memoryGiB: 7 });
        assert.deepEqual(c4MachineShape("c4-standard-8"), { vcpus: 8, memoryGiB: 30 });
        assert.deepEqual(c4MachineShape("c4-highcpu-8"), { vcpus: 8, memoryGiB: 16 });
        assert.deepEqual(c4MachineShape("c4-highmem-4"), { vcpus: 4, memoryGiB: 31 });
        for (const bad of ["n2-standard-2", "c4d-standard-2", "c4-standard-3", "c4-standard-2-lssd", "e2-micro"]) {
            assert.equal(c4MachineShape(bad), null, bad);
        }
    });

    it("extracts C4 spot core and RAM prices from real catalog SKUs, ignoring other families", () => {
        const table = parseC4SpotPrices(fixture, 1000);
        assert.equal(table.fetchedAt, 1000);
        const regions = Object.keys(table.regions);
        assert.ok(regions.length >= 30, `regions=${regions.length}`);
        for (const p of Object.values(table.regions)) {
            assert.ok(p.core > 0 && p.core < 0.2, `core ${p.core}`);
            assert.ok(p.ram > 0 && p.ram < 0.05, `ram ${p.ram}`);
        }
        // on-demand C4 价格远高于 spot：确认没有混入
        const onDemand = fixture.find((s: any) => s.description.startsWith("C4 Instance Core running in Iowa"));
        const iowa = table.regions["us-central1"];
        if (onDemand && iowa) {
            const r = onDemand.pricingInfo[0].pricingExpression.tieredRates.at(-1).unitPrice;
            assert.ok(Number(r.units ?? 0) + r.nanos / 1e9 > iowa.core);
        }
    });

    it("ranks candidate regions by hourly price for the machine type, unpriced last", () => {
        const table = parseC4SpotPrices(fixture);
        const ranked = rankRegions(table, "c4-standard-2", ["us-central1", "northamerica-northeast1", "europe-west9", "mars-north1"]);
        assert.equal(ranked[ranked.length - 1].region, "mars-north1");
        assert.equal(ranked[ranked.length - 1].hourlyUsd, Number.POSITIVE_INFINITY);
        for (let i = 1; i < ranked.length - 1; i++) assert.ok(ranked[i - 1].hourlyUsd <= ranked[i].hourlyUsd);
        const p = table.regions["us-central1"];
        const iowa = ranked.find((r) => r.region === "us-central1")!;
        assert.ok(Math.abs(iowa.hourlyUsd - (p.core * 2 + p.ram * 7)) < 1e-12);
        assert.throws(() => rankRegions(table, "n2-standard-2", ["us-central1"]), /只支持 C4/);
    });

    it("refreshes once a day, persists the cache and keeps the old table when refresh fails", async () => {
        let now = 10 * 86_400_000;
        let calls = 0;
        let fail = false;
        const cache = join(dir, "prices.json");
        const book = new SpotPriceBook(cache, async () => {
            calls++;
            if (fail) throw new Error("catalog down");
            return fixture;
        }, () => now);
        const first = await book.get();
        assert.ok(first && Object.keys(first.regions).length > 0);
        await book.get();
        assert.equal(calls, 1, "cached within a day");
        now += 25 * 3_600_000;
        fail = true;
        const stale = await book.get();
        assert.equal(calls, 2);
        assert.equal(stale?.fetchedAt, first!.fetchedAt, "falls back to the previous table");
        // 新实例从磁盘缓存加载
        const reloaded = new SpotPriceBook(cache, async () => { throw new Error("unused"); }, () => first!.fetchedAt + 1000);
        assert.equal((await reloaded.get())?.fetchedAt, first!.fetchedAt);
    });
});
