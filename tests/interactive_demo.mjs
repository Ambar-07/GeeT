import fs from "node:fs";
import path from "node:path";
import { chromium } from "../node_modules/@playwright/test/index.mjs";

const artifactDir = "C:/Users/ambar/.gemini/antigravity/brain/fed98f7b-de59-4122-b02c-3410ca1cb7cb";
const testMusicDir = path.resolve(".e2e-tmp/demo_music");

function createWav(filePath, durationSec = 10) {
  const sampleRate = 8000;
  const numSamples = sampleRate * durationSec;
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // Mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  fs.writeFileSync(filePath, buf);
}

async function runInteractiveTest() {
  fs.mkdirSync(testMusicDir, { recursive: true });

  // 1. Prepare 3 songs with timed lyrics
  createWav(path.join(testMusicDir, "01_Bohemian_Rhapsody.wav"), 15);
  fs.writeFileSync(
    path.join(testMusicDir, "01_Bohemian_Rhapsody.lrc"),
    `[00:00.50]Is this the real life?
[00:03.00]Is this just fantasy?
[00:06.00]Caught in a landslide
[00:09.00]No escape from reality
[00:12.00]Open your eyes...
`,
    "utf8"
  );

  createWav(path.join(testMusicDir, "02_Hotel_California.wav"), 20);
  fs.writeFileSync(
    path.join(testMusicDir, "02_Hotel_California.lrc"),
    `[00:01.00]On a dark desert highway
[00:05.00]Cool wind in my hair
[00:09.00]Warm smell of colitas
[00:13.00]Rising up through the air
`,
    "utf8"
  );

  createWav(path.join(testMusicDir, "03_Dont_Stop_Believin.wav"), 15);

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  console.log("1. Visiting Home Page...");
  await page.goto("http://127.0.0.1:5173");
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: path.join(artifactDir, "step1_home.png") });

  console.log("2. Navigating to Host Console...");
  await page.goto("http://127.0.0.1:5173/host");
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: path.join(artifactDir, "step2_host_initial.png") });

  console.log("3. Scanning local music library...");
  await page.getByLabel("Local music folder path").fill(testMusicDir);
  await page.getByRole("button", { name: "Add & Scan" }).click();
  await page.waitForSelector("text=01_Bohemian_Rhapsody", { timeout: 10000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(artifactDir, "step3_library_scanned.png") });

  console.log("4. Playing Bohemian Rhapsody and checking live lyrics...");
  // Click Play on the first song
  const playButtons = page.getByRole("button", { name: "Play" });
  await playButtons.first().click();
  await page.waitForSelector("text=Now Playing", { timeout: 10000 });
  await page.waitForSelector("text=Is this the real life?", { timeout: 10000 });
  await page.getByRole("button", { name: "Reset" }).click();
  await page.getByRole("button", { name: "Is this the real life?" }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(artifactDir, "step4_playing_lyrics.png") });

  console.log("5. Testing Lyrics Calibration and Editor...");
  await page.getByRole("button", { name: "+500ms" }).click();
  await page.getByRole("button", { name: "+1s" }).click();
  await page.getByRole("button", { name: "Edit / Import" }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(artifactDir, "step5_lyrics_calibration.png") });

  console.log("6. Testing Participant Join flow...");
  await page.goto("http://127.0.0.1:5173/join/PARTY77");
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: path.join(artifactDir, "step6_participant_join.png") });

  await browser.close();
  console.log("All interactive Playwright test steps completed successfully!");
}

runInteractiveTest().catch((err) => {
  console.error("Test error:", err);
  process.exit(1);
});
