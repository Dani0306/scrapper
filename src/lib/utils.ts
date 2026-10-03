import { Page } from "puppeteer";

export async function prep(page: Page) {
  await page.setRequestInterception(true);
  // eslint-disable-next-line
  page.on("request", (req: any) => {
    const t = req.resourceType();
    if (["image", "font", "media", "stylesheet"].includes(t))
      return req.abort();
    req.continue();
  });
  page.setDefaultNavigationTimeout(25_000);
}
