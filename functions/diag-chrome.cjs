// Throwaway diagnostic: how long does Puppeteer take to get Chrome's WS endpoint on the runner?
const puppeteer = require("puppeteer-core");
const t0 = Date.now();
const ms = () => String(Date.now() - t0).padStart(6);
const write = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) =>
  write(String(chunk).split("\n").filter(Boolean).map((l) => `[${ms()}] ${l}`).join("\n") + "\n", ...rest);

(async () => {
  const label = process.argv[2] || "launch";
  const start = Date.now();
  const browser = await puppeteer.launch({
    executablePath: process.env.FIBUKI_CHROME_PATH || "/usr/bin/google-chrome",
    headless: true,
    dumpio: true,
    timeout: 180000,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--enable-logging=stderr", "--v=0"],
  });
  const launched = Date.now() - start;
  const page = await browser.newPage();
  await page.setContent("<p>x</p>");
  await page.pdf({ format: "A4" });
  const rendered = Date.now() - start - launched;
  await browser.close();
  console.log(`RESULT ${label}: launch=${launched}ms firstPdf=${rendered}ms`);
})().catch((e) => {
  console.log(`RESULT ${process.argv[2]}: FAILED after ${Date.now() - t0}ms: ${e.message}`);
  process.exit(1);
});
