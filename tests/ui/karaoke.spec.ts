import { expect, test, type Page } from "@playwright/test";

const songs = Array.from({ length: 24 }, (_, i) => ({
  id: (i + 1).toString(16).padStart(16, "0"),
  title: ["Shaam", "Ilahi", "Aaj Ki Raat", "Kun Faya Kun", "Phir Se Ud Chala", "Iktara", "Tum Se Hi", "Safarnama"][i % 8] + (i > 7 ? ` ${i}` : ""),
  artist: "Karaoke test artist", album: "Evening sessions", duration_ms: 30_000,
  format: "wav", readiness: "ready", has_lyrics: true, has_instrumental: true, has_cover: false,
}));

function silentWav() {
  const bytes = 8000 * 30 * 2;
  const buf = Buffer.alloc(44 + bytes);
  buf.write("RIFF"); buf.writeUInt32LE(36 + bytes, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(8000, 24); buf.writeUInt32LE(16000, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(bytes, 40);
  return buf;
}

async function mockHost(page: Page, options: { offline?: boolean; empty?: boolean; pagination?: boolean; needsPreparation?: boolean } = {}) {
  const state = { ...options, scanCount: 0, failMore: false, failSave: false, cleared: false, jobPolls: 0 };
  const currentSongs = () => songs.map(song => ({ ...song, has_instrumental: !state.needsPreparation && !state.cleared }));
  await page.route("**/lan-api/**", route => route.fulfill({ json: { lan_ip: "127.0.0.1", host_bind: "127.0.0.1", port: 8765, active_rooms: 0 } }));
  await page.route("http://127.0.0.1:8765/**", async route => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    if (state.offline) return route.abort();
    if (pathname === "/health") return route.fulfill({ json: { status: "ok", sqlite: true, ffmpeg: true, ffprobe: true, demucs: true, approved_dirs: 1, song_count: state.empty ? 0 : songs.length } });
    if (pathname === "/library/songs") {
      const query = url.searchParams.get("query") || "";
      if (query === "older") await new Promise(resolve => setTimeout(resolve, 850));
      if (url.searchParams.has("cursor") && state.failMore) return route.fulfill({ status: 503, json: {} });
      const results = state.empty ? [] : query === "older" ? [songs[0]] : query === "newer" ? [songs[1]] : currentSongs().filter(song => song.title.toLowerCase().includes(query.toLowerCase()));
      return route.fulfill({ json: { songs: state.pagination ? (url.searchParams.has("cursor") ? results.slice(7) : results.slice(0, 8)) : results, next_cursor: state.pagination && !url.searchParams.has("cursor") ? "page2" : null } });
    }
    if (pathname.startsWith("/library/songs/")) return route.fulfill({ json: currentSongs().find(song => song.id === pathname.split("/").pop()) });
    if (pathname.endsWith("/cache/clear")) { state.cleared = true; return route.fulfill({ json: {} }); }
    if (pathname.endsWith("/prepare")) return route.fulfill({ json: { job_id: "test-job", song_id: songs[0].id, status: "queued", device: "cpu" } });
    if (pathname === "/jobs/test-job") {
      state.jobPolls++;
      const done = state.jobPolls > 1;
      if (done) state.needsPreparation = false;
      return route.fulfill({ json: { id: "test-job", kind: "separate", song_id: songs[0].id, status: done ? "completed" : "queued", progress: done ? 100 : 0 } });
    }
    if (pathname.startsWith("/media/")) return route.fulfill({ contentType: "audio/wav", body: silentWav() });
    if (pathname.endsWith("/lyrics")) {
      if (state.failSave && route.request().method() === "PUT") return route.fulfill({ status: 500, json: {} });
      const payload = route.request().method() === "PUT" ? route.request().postDataJSON() : {};
      return route.fulfill({ json: { song_id: pathname.split("/")[2], lrc_text: "[00:00.00]This is your moment\n[00:12.00]Let the room sing along\n[00:20.00]One more encore", offset_ms: 0, source: "sidecar", synchronized_ready: true, ...payload } });
    }
    if (pathname === "/library/select") return route.fulfill({ json: { approved_dirs: 1 } });
    if (pathname === "/library/scan") {
      state.scanCount++;
      await new Promise(resolve => setTimeout(resolve, 400));
      state.empty = false;
      return route.fulfill({ json: { scanned: 24, skipped_unchanged: 0 } });
    }
    return route.fulfill({ json: {} });
  });
  return state;
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
}

test("home and join are usable on a phone", async ({ page }) => {
  await mockHost(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Join", exact: true })).toBeDisabled();
  await noOverflow(page);
  await page.screenshot({ path: ".e2e-tmp/home-mobile.png", fullPage: true });
  await page.getByLabel("Room code", { exact: true }).fill("ab12cd34");
  await page.getByRole("button", { name: "Join", exact: true }).click();
  await expect(page).toHaveURL(/\/join\/AB12CD34$/);
  await expect(page.getByLabel("Your display name")).toBeVisible();
  await noOverflow(page);
});

test("library and settings fit phones, tablets and desktops", async ({ page }) => {
  await mockHost(page);
  await page.goto("/host");
  await expect(page.locator(".track-row")).toHaveCount(24);
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await noOverflow(page);
    await page.getByRole("button", { name: "Library & settings" }).click();
    const box = await page.locator(".settings-popover").boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    await expect(page.getByLabel("Local music folder path")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.locator(".settings-popover")).toHaveCount(0);
    await page.screenshot({ path: `.e2e-tmp/host-${width}.png`, fullPage: true });
  }
});

test("offline state can reconnect without reloading", async ({ page }) => {
  const state = await mockHost(page, { offline: true });
  await page.goto("/host");
  await expect(page.getByText("Host agent is offline")).toBeVisible();
  state.offline = false;
  await page.getByRole("button", { name: "Reconnect" }).click();
  await expect(page.locator(".track-row")).toHaveCount(24);
});

test("late search responses cannot replace newer results", async ({ page }) => {
  await mockHost(page);
  await page.goto("/host");
  await expect(page.locator(".track-row")).toHaveCount(24);
  const older = page.waitForRequest(request => request.url().includes("query=older"));
  await page.getByLabel("Search indexed songs").fill("older");
  await older;
  await page.getByLabel("Search indexed songs").fill("newer");
  await expect(page.locator(".track-row")).toHaveCount(1);
  await expect(page.locator(".track-row")).toContainText("Ilahi");
  await page.waitForTimeout(1000);
  await expect(page.locator(".track-row")).toContainText("Ilahi");
  await expect(page.locator(".album-card")).toHaveCount(1);
  await expect(page.locator(".album-card")).toContainText("Ilahi");
});

test("pagination errors are recoverable and repeated songs are deduplicated", async ({ page }) => {
  const state = await mockHost(page, { pagination: true });
  await page.goto("/host");
  await expect(page.locator(".track-row")).toHaveCount(8);
  state.failMore = true;
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByRole("status").filter({ hasText: "List songs failed" })).toBeVisible();
  state.failMore = false;
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.locator(".track-row")).toHaveCount(24);
});

test("empty-library scan is single-flight with one settings input", async ({ page }) => {
  const state = await mockHost(page, { empty: true });
  await page.goto("/host");
  await page.getByRole("button", { name: "Library & settings" }).click();
  await expect(page.getByLabel("Local music folder path")).toHaveCount(1);
  await page.getByLabel("Local music folder path").fill("D:\\Music");
  await page.getByRole("button", { name: "Add & Scan", exact: true }).click();
  await expect(page.getByRole("button", { name: "Scanning…" })).toBeDisabled();
  await expect(page.locator(".track-row")).toHaveCount(24);
  expect(state.scanCount).toBe(1);
});

test("playback, pause across stem changes, lyrics recovery, keyboard and TV mode", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const state = await mockHost(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/host");
  await page.locator(".track-row").first().getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause playback" })).toBeVisible();
  await expect(page.getByText("This is your moment", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Library", exact: true }).focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Pause playback" })).toBeVisible();
  await page.getByRole("button", { name: "Pause playback" }).click();
  await page.getByRole("button", { name: "Audio stem options" }).click();
  await page.getByRole("button", { name: /^original$/i }).click();
  await expect(page.locator("audio").first()).toHaveJSProperty("paused", true);
  await expect(page.locator("audio").first()).toHaveJSProperty("readyState", 4);
  await page.getByRole("button", { name: "Toggle lyrics editor and timing" }).click();
  state.failSave = true;
  await page.getByRole("button", { name: "Save LRC", exact: true }).click();
  await expect(page.getByText("Save lyrics failed: 500")).toBeVisible();
  await expect(page.getByLabel("Timed LRC lyrics editor")).toBeVisible();
  state.failSave = false;
  await page.getByRole("button", { name: "Save LRC", exact: true }).click();
  await expect(page.getByLabel("Timed LRC lyrics editor")).toHaveCount(0);
  await page.getByRole("button", { name: /^instrumental$/i }).click();
  await page.getByRole("button", { name: "Resume playback" }).click();
  await expect(page.getByRole("button", { name: "Pause playback" })).toBeVisible();
  await page.getByRole("button", { name: "Clear Cache", exact: true }).click();
  await expect(page.locator("audio").first()).toHaveAttribute("src", /\/media\/[a-f0-9]{16}$/);
  await expect(page.getByRole("button", { name: "Pause playback" })).toBeVisible();
  await page.getByRole("button", { name: "Pause playback" }).click();
  await page.getByRole("button", { name: "Audio stem options" }).click();
  await page.screenshot({ path: ".e2e-tmp/player-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "TV Stage Mode", exact: true }).click();
  await expect(page.getByRole("button", { name: "Exit TV Stage Mode" })).toBeVisible();
  await expect(page.locator("audio").first()).toHaveJSProperty("paused", true);
  await page.screenshot({ path: ".e2e-tmp/player-tv.png", fullPage: true });
  await page.getByRole("button", { name: "Exit TV Stage Mode" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await page.screenshot({ path: ".e2e-tmp/player-mobile.png", fullPage: true });
  expect(errors).toEqual([]);
});

for (const paused of [true, false]) {
  test(`completed stem preparation preserves ${paused ? "paused" : "playing"} playback`, async ({ page }) => {
    await mockHost(page, { needsPreparation: true });
    await page.goto("/host");
    await page.locator(".track-row").first().getByRole("button", { name: "Play", exact: true }).click();
    await expect(page.getByRole("button", { name: "Pause playback" })).toBeVisible();
    if (paused) await page.getByRole("button", { name: "Pause playback" }).click();
    await page.getByRole("button", { name: "Toggle instrumental karaoke mode" }).click();
    await expect(page.locator("audio").first()).toHaveAttribute("src", /mode=instrumental/);
    await expect(page.locator("audio").first()).toHaveJSProperty("readyState", 4);
    await expect(page.locator("audio").first()).toHaveJSProperty("paused", paused);
  });
}
