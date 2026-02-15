/**
 * HTML to PDF Converter
 *
 * Converts email HTML content to PDF for storage as a receipt file.
 * Uses Puppeteer (headless Chrome) for high-quality rendering that preserves
 * HTML layout, tables, images, and CSS styling.
 *
 * Uses @sparticuz/chromium for serverless environments (Cloud Functions).
 */

import chromium from "@sparticuz/chromium";
import puppeteer, { Browser } from "puppeteer-core";

export interface PdfConversionResult {
  pdfBuffer: Buffer;
  pageCount: number;
}

// Singleton browser instance for performance - reused across requests
let browserInstance: Browser | null = null;
let browserLaunchPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (browserInstance && browserInstance.connected) {
    return browserInstance;
  }

  // Prevent multiple simultaneous launches
  if (browserLaunchPromise) {
    return browserLaunchPromise;
  }

  // Check if running in emulator - use local Chrome instead of @sparticuz/chromium
  const isEmulator = process.env.FUNCTIONS_EMULATOR === "true";

  if (isEmulator) {
    // In emulator, try to use local Chrome/Chromium
    // Common paths for Chrome on different platforms
    const localChromePaths = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", // macOS
      "/usr/bin/google-chrome", // Linux
      "/usr/bin/chromium-browser", // Linux Chromium
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", // Windows
    ];

    let execPath: string | undefined;
    for (const path of localChromePaths) {
      try {
        const { existsSync } = await import("fs");
        if (existsSync(path)) {
          execPath = path;
          break;
        }
      } catch {
        // Continue to next path
      }
    }

    if (!execPath) {
      throw new Error(
        "PDF generation requires Chrome. Install Chrome or run in Cloud Functions."
      );
    }

    browserLaunchPromise = puppeteer.launch({
      executablePath: execPath,
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  } else {
    // In Cloud Functions, use @sparticuz/chromium
    chromium.setGraphicsMode = false;

    browserLaunchPromise = puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: "shell",
    });
  }

  browserInstance = await browserLaunchPromise;
  browserLaunchPromise = null;

  // Handle browser disconnect
  browserInstance.on("disconnected", () => {
    browserInstance = null;
  });

  return browserInstance;
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Convert HTML email content to a PDF document using Puppeteer.
 * Preserves full HTML layout, tables, images, and CSS styling.
 *
 * @param html - The HTML content of the email
 * @param metadata - Optional metadata to include in the PDF header
 * @returns PDF as a Buffer with page count
 */
export async function convertHtmlToPdf(
  html: string,
  metadata?: {
    subject?: string;
    from?: string;
    date?: Date;
  }
): Promise<PdfConversionResult> {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    // Detect if the input is already a complete HTML document (e.g. captured from browser extension)
    const isFullDocument = /^\s*<!DOCTYPE\s+html/i.test(html) || /^\s*<html[\s>]/i.test(html);

    let fullHtml: string;
    if (isFullDocument) {
      // Already a complete document — use as-is (e.g. page capture from browser extension)
      fullHtml = html;
    } else {
      // Build a complete HTML document with email header
      const headerHtml = metadata
        ? `
        <div style="margin-bottom: 20px; padding-bottom: 15px; border-bottom: 1px solid #ddd;">
          ${metadata.subject ? `<h2 style="margin: 0 0 8px 0; font-size: 18px; color: #333;">${escapeHtml(metadata.subject)}</h2>` : ""}
          ${metadata.from ? `<p style="margin: 0 0 4px 0; font-size: 12px; color: #666;">From: ${escapeHtml(metadata.from)}</p>` : ""}
          ${metadata.date && !isNaN(metadata.date.getTime()) ? `<p style="margin: 0; font-size: 12px; color: #666;">Date: ${metadata.date.toLocaleDateString("de-DE")}</p>` : ""}
        </div>
      `
        : "";

      fullHtml = `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="UTF-8">
            <style>
              body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
                font-size: 14px;
                line-height: 1.5;
                color: #333;
                max-width: 100%;
                padding: 20px;
                box-sizing: border-box;
              }
              table {
                border-collapse: collapse;
                width: 100%;
              }
              td, th {
                padding: 8px;
                text-align: left;
              }
              img {
                max-width: 100%;
                height: auto;
              }
            </style>
          </head>
          <body>
            ${headerHtml}
            ${html}
          </body>
        </html>
      `;
    }

    // Use 'domcontentloaded' instead of 'networkidle0' - don't wait for external images
    // Email HTML often has broken cid: references and tracking pixels that never load
    await page.setContent(fullHtml, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });

    // Brief wait for any inline styles to apply
    await new Promise((resolve) => setTimeout(resolve, 500));

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: {
        top: "20mm",
        right: "15mm",
        bottom: "20mm",
        left: "15mm",
      },
    });

    // Estimate page count (rough calculation based on buffer size)
    // A typical A4 PDF page is ~3-5KB for text, more with images
    const pageCount = Math.max(1, Math.ceil(pdfBuffer.length / 50000));

    return {
      pdfBuffer: Buffer.from(pdfBuffer),
      pageCount,
    };
  } finally {
    await page.close();
  }
}

/**
 * Check if HTML content is complex (informational only, Puppeteer handles all cases).
 * Returns true if the content has tables, images, or complex CSS.
 */
export function isComplexHtml(html: string): boolean {
  // Check for complex elements
  const hasTable = /<table[\s>]/i.test(html);
  const hasImages = /<img[\s>]/i.test(html);
  const hasCanvas = /<canvas[\s>]/i.test(html);
  const hasSvg = /<svg[\s>]/i.test(html);
  const hasIframe = /<iframe[\s>]/i.test(html);

  // Check for complex CSS (inline styles with positioning)
  const hasComplexCss =
    /position:\s*(absolute|fixed|relative)/i.test(html) ||
    /display:\s*(flex|grid)/i.test(html) ||
    /float:\s*(left|right)/i.test(html);

  return hasTable || hasImages || hasCanvas || hasSvg || hasIframe || hasComplexCss;
}
