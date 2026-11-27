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

  await page.getByRole("button", { name: "Library & settings" }).click();
  await page.getByLabel("Local music folder path").fill(musicDir);
  await page.getByRole("button", { name: "Add & Scan" }).click();
  await expect(page.getByText(/Imported \d+ tracks\./)).toBeVisible();
  await page.getByRole("button", { name: "Backup DB" }).click();
  await expect(page.getByText(/SQLite backup saved: host_agent-/)).toBeVisible();
  await page.getByRole("button", { name: "Close settings" }).click();

  await page.getByLabel("Search indexed songs").fill("e2e_track");
  await expect(page.getByText("e2e track").first()).toBeVisible();

  await page.locator("li", { hasText: "e2e track" }).getByRole("button", { name: "Play" }).click();
  const audio = page.locator("audio").first();
  await expect(audio).toHaveAttribute("src", /http:\/\/127\.0\.0\.1:8765\/media\/[a-f0-9]{16}/);
  await expect(page.getByText("E2E Sync Line")).toBeVisible();
});

test("LAN Party Room guest queue, live sync status, reactions, and TV stage overlay", async ({
  browser,
}) => {
  const musicDir = path.resolve(".e2e-tmp/music");
  fs.mkdirSync(musicDir, { recursive: true });
  writeMinimalWav(path.join(musicDir, "party_song.wav"));
  fs.writeFileSync(path.join(musicDir, "party_song.lrc"), "[00:00.00]Party Stage Lyric\n", "utf8");

  const hostContext = await browser.newContext();
  const hostPage = await hostContext.newPage();

  await hostPage.goto("/host");
  await expect(hostPage.getByText(/Connected • \d+ songs/)).toBeVisible();

  await hostPage.getByRole("button", { name: "Library & settings" }).click();
  await hostPage.getByLabel("Local music folder path").fill(musicDir);
  await hostPage.getByRole("button", { name: "Add & Scan" }).click();
  await expect(hostPage.getByText(/Imported \d+ tracks\./)).toBeVisible();
  await hostPage.getByRole("button", { name: "Close settings" }).click();

  await hostPage.getByLabel("Search indexed songs").fill("party_song");
  await expect(hostPage.getByText("party song").first()).toBeVisible();

  // Switch to Party tab and start LAN Party Room (zero-cloud fallback)
  await hostPage.getByRole("tab", { name: /Party/ }).click();
  await hostPage.getByRole("button", { name: "Start LAN Party Room" }).click();
  await expect(hostPage.getByText("LAN Live")).toBeVisible();

  // Grab room code from join link
  const joinAnchor = hostPage.locator('a[href^="/join/"]').first();
  const joinHref = await joinAnchor.getAttribute("href");
  expect(joinHref).toMatch(/^\/join\/[A-Z0-9]{8}$/);

  // Switch host to TV Stage Mode and verify overlay shows QR + room code without dropping sync
  await hostPage.getByRole("button", { name: "TV Stage Mode" }).click();
  await expect(hostPage.getByText("Scan to Queue")).toBeVisible();

  // Guest joins in a second browser context
  const guestContext = await browser.newContext();
  const guestPage = await guestContext.newPage();
  await guestPage.goto(joinHref!);

  await guestPage.getByLabel("Your display name").fill("Maya");
  await guestPage.getByRole("button", { name: "Enter Room" }).click();
  await expect(guestPage.getByText("LAN Live")).toBeVisible();

  // Guest searches, queues song, and sends reaction
  await guestPage.getByLabel("Search room songs").fill("party_song");
  await guestPage.locator("li", { hasText: "party song" }).getByRole("button", { name: "Queue" }).click();
  await expect(guestPage.getByText("You're Up Next!")).toBeVisible();

  await guestPage.getByRole("button", { name: /Encore/ }).click();

  // Host TV Stage displays floating reaction burst AND Up Next chip while in TV Stage Mode
  const stage = hostPage.getByRole("main", { name: "Karaoke Stage" });
  await expect(stage.getByText("· Maya")).toBeVisible();
  await expect(stage.getByText("(Maya)")).toBeVisible();

  // Host starts Maya's queued track -> host TV stage announces Maya & guest phone gets live lyrics
  await hostPage.getByRole("button", { name: /Play Up Next/ }).click();
  await expect(stage.getByText(/Now on Stage · Maya/)).toBeVisible();
  await expect(guestPage.getByText("You're On Stage Now!")).toBeVisible();
  await expect(guestPage.getByText("Party Stage Lyric")).toBeVisible();

  await guestContext.close();
  await hostContext.close();
});
