import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

function writeMinimalWav(filePath: string) {
  const sampleRate = 8000;
  const numSamples = 4000;
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  fs.writeFileSync(filePath, buf);
}

test("home join flow and host console local playback + backup", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "GeeT Karaoke" })).toBeVisible();

  await page.getByLabel("Room code").fill("ab12cd34");
  await page.getByRole("button", { name: "Join" }).click();
  await expect(page).toHaveURL(/\/join\/AB12CD34$/);

  // Create a local test music fixture with sidecar LRC
  const musicDir = path.resolve(".e2e-tmp/music");
  fs.mkdirSync(musicDir, { recursive: true });
  writeMinimalWav(path.join(musicDir, "e2e_track.wav"));
  fs.writeFileSync(path.join(musicDir, "e2e_track.lrc"), "[00:00.00]E2E Sync Line\n", "utf8");

  await page.goto("/host");
  await expect(page.getByText(/Connected • \d+ songs/)).toBeVisible();

  await page.getByLabel("Local music folder path").fill(musicDir);
  await page.getByRole("button", { name: "Add & Scan" }).click();
  await expect(page.getByText("e2e_track").first()).toBeVisible();

  await page.locator("li", { hasText: "e2e_track" }).getByRole("button", { name: "Play" }).click();
  const audio = page.locator("audio");
  await expect(audio).toHaveAttribute("src", /http:\/\/127\.0\.0\.1:8765\/media\/[a-f0-9]{16}/);
  await expect(page.getByText("E2E Sync Line")).toBeVisible();

  await page.getByRole("button", { name: "Backup DB" }).click();
  await expect(page.getByText(/SQLite backup saved: host_agent-/)).toBeVisible();
});
