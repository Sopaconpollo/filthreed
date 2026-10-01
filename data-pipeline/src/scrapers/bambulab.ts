import { chromium } from "playwright";

const URL = "https://centroimpresion3d.com/tienda?cat=filamentos#catalogo";

async function main() {
    console.log("Iniciando scraper de Centro3D...");

    const browser = await chromium.launch({
        headless: false
    });

    const page = await browser.newPage();

    console.log(`Visitando: ${URL}`);

    await page.goto(URL, {
        waitUntil: "domcontentloaded",
        timeout: 60000
    });

    console.log("Página cargada.");
    console.log("Título:", await page.title());
    console.log("URL actual:", page.url());

    await page.waitForTimeout(3000);

    await browser.close();

    console.log("Scraping de prueba terminado.");
}

main().catch((error) => {
    console.error("Error durante el scraping:", error);
    process.exit(1);
});