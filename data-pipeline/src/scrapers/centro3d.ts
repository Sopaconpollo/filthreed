import { chromium, Page } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = "https://centroimpresion3d.com";
const SHOP_URL = `${BASE_URL}/tienda?cat=filamentos#catalogo`;

const OUTPUT_DIR = path.join(process.cwd(), "data");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "centro3d.json");

interface Producto {
    id: string;
    sku: string;
    nombre: string;
    slug: string;
    descripcion: string;
    precio: number;
    moneda: string;
    stock: number;
    disponible: boolean;
    marca: string | null;
    variantes: number;
    tipo: string | null;
    categorias: string[];
    imagenes: {
        url: string;
        alt: string;
    }[];
    url: string;
}

/**
 * El servidor de Centro3D utiliza un formato serializado
 * con estructuras como:
 *
 * {
 *   t: 10,
 *   p: {
 *      k: ["id", "name", ...],
 *      v: [...]
 *   }
 * }
 *
 * Esta función convierte ese formato a objetos JavaScript normales.
 */
function decodeServerData(value: any): any {
    if (value === null || value === undefined) {
        return value;
    }

    if (Array.isArray(value)) {
        return value.map(decodeServerData);
    }

    if (typeof value !== "object") {
        return value;
    }

    // Objeto serializado como { t: ..., s: ... }
    if (value.t === 1 && "s" in value) {
        return value.s;
    }

    // Números serializados
    if ((value.t === 0 || value.t === 2) && "s" in value) {
        return Number(value.s);
    }

    // Array serializado
    if (value.t === 9 && Array.isArray(value.a)) {
        return value.a.map(decodeServerData);
    }

    // Objeto serializado
    if (value.t === 10 && value.p) {
        const keys = value.p.k || [];
        const values = value.p.v || [];

        const result: Record<string, any> = {};

        for (let i = 0; i < keys.length; i++) {
            result[keys[i]] = decodeServerData(values[i]);
        }

        return result;
    }

    // Objeto normal
    const result: Record<string, any> = {};

    for (const [key, val] of Object.entries(value)) {
        result[key] = decodeServerData(val);
    }

    return result;
}

/**
 * Convierte una URL de imagen relativa en absoluta.
 */
function absoluteUrl(url: string): string {
    if (!url) {
        return "";
    }

    if (url.startsWith("http://") || url.startsWith("https://")) {
        return url;
    }

    return `${BASE_URL}${url.startsWith("/") ? "" : "/"}${url}`;
}

/**
 * Convierte la respuesta interna de Centro3D
 * en productos normales.
 */
function extractProductsFromResponse(data: any): {
    products: any[];
    total: number;
    page: number;
    limit: number;
} {
    try {
        const decoded = decodeServerData(data);

        const result = decoded?.result;

        if (!result) {
            return {
                products: [],
                total: 0,
                page: 1,
                limit: 24
            };
        }

        return {
            products: result.products || [],
            total: Number(result.total || 0),
            page: Number(result.page || 1),
            limit: Number(result.limit || 24)
        };
    } catch (error) {
        console.error("Error decodificando respuesta:", error);

        return {
            products: [],
            total: 0,
            page: 1,
            limit: 24
        };
    }
}

/**
 * Normaliza un producto al formato que usaremos en FilThreed.
 */
function normalizeProduct(product: any): Producto {
    const images = Array.isArray(product.images)
        ? product.images.map((image: any) => ({
              url: absoluteUrl(image?.url || ""),
              alt: image?.alt || product.name || ""
          }))
        : [];

    const categorias = Array.isArray(product.categoryIds)
        ? product.categoryIds
        : [];

    return {
        id: product.id || "",
        sku: product.sku || "",
        nombre: product.name || "",
        slug: product.slug || "",
        descripcion: product.short_description || "",
        precio: Number(product.price || 0),
        moneda: product.currency || "COP",
        stock: Number(product.stock || 0),
        disponible: Boolean(product.in_stock),
        marca: product.brand || null,
        variantes: Number(product.variantCount || 0),
        tipo: product.target || null,
        categorias,
        imagenes: images,
        url: `${BASE_URL}/producto/${product.slug}`
    };
}

/**
 * Hace una petición a la página de la tienda y espera
 * a que aparezca la respuesta dinámica de productos.
 */
async function scrapePage(page: Page, pageNumber: number) {
    return new Promise<{
        products: any[];
        total: number;
        page: number;
        limit: number;
    }>((resolve, reject) => {
        let resolved = false;

        const timeout = setTimeout(() => {
            if (!resolved) {
                resolved = true;

                reject(
                    new Error(
                        `Timeout esperando los productos de la página ${pageNumber}`
                    )
                );
            }
        }, 60000);

        const responseHandler = async (response: any) => {
            try {
                const url = response.url();

                // Solo nos interesa la llamada _serverFn que
                // contiene los productos.
                if (!url.includes("/_serverFn/")) {
                    return;
                }

                const contentType =
                    response.headers()["content-type"] || "";

                if (!contentType.includes("application/json")) {
                    return;
                }

                const text = await response.text();

                if (!text.includes('"products"')) {
                    return;
                }

                const json = JSON.parse(text);

                const result = extractProductsFromResponse(json);

                if (result.products.length === 0) {
                    return;
                }

                resolved = true;
                clearTimeout(timeout);

                page.off("response", responseHandler);

                resolve(result);
            } catch {
                // Puede haber varias respuestas JSON.
                // Ignoramos las que no sean la respuesta de productos.
            }
        };

        page.on("response", responseHandler);

        const url =
            pageNumber === 1
                ? SHOP_URL
                : `${BASE_URL}/tienda?cat=filamentos&page=${pageNumber}#catalogo`;

        page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: 60000
        }).catch((error) => {
            if (!resolved) {
                resolved = true;
                clearTimeout(timeout);

                page.off("response", responseHandler);

                reject(error);
            }
        });
    });
}

async function main() {
    console.log("");
    console.log("==========================================");
    console.log("CENTRO3D — SCRAPER DE FILAMENTOS");
    console.log("==========================================");
    console.log("");

    const browser = await chromium.launch({
        headless: true
    });

    const page = await browser.newPage();

    const productosMap = new Map<string, Producto>();

    try {
        let pagina = 1;
        let totalEsperado = Infinity;
        let limite = 24;

        while (productosMap.size < totalEsperado) {
            console.log("");
            console.log("------------------------------------------");
            console.log(`PÁGINA ${pagina}`);
            console.log("------------------------------------------");

            const resultado = await scrapePage(page, pagina);

            totalEsperado = resultado.total;
            limite = resultado.limit;

            console.log(`Productos recibidos: ${resultado.products.length}`);
            console.log(`Total indicado por API: ${totalEsperado}`);
            console.log(`Límite por página: ${limite}`);

            for (const rawProduct of resultado.products) {
                const producto = normalizeProduct(rawProduct);

                if (!producto.id && !producto.sku) {
                    continue;
                }

                const key = producto.id || producto.sku;

                if (!productosMap.has(key)) {
                    productosMap.set(key, producto);
                }
            }

            console.log(
                `Productos acumulados: ${productosMap.size}`
            );

            // Si recibimos menos productos que el límite,
            // probablemente ya llegamos a la última página.
            if (resultado.products.length < limite) {
                break;
            }

            // Seguridad para evitar loops infinitos.
            if (pagina > 100) {
                console.log(
                    "Se alcanzó el límite de seguridad de 100 páginas."
                );
                break;
            }

            pagina++;
        }

        const productos = Array.from(productosMap.values());

        console.log("");
        console.log("==========================================");
        console.log("RESULTADO FINAL");
        console.log("==========================================");
        console.log("");
        console.log(`Productos únicos: ${productos.length}`);
        console.log(`Total indicado por API: ${totalEsperado}`);
        console.log("");

        productos.forEach((producto, index) => {
            console.log(`PRODUCTO ${index + 1}`);
            console.log(`Nombre: ${producto.nombre}`);
            console.log(`SKU: ${producto.sku}`);
            console.log(`Precio: $${producto.precio.toLocaleString("es-CO")}`);
            console.log(`Moneda: ${producto.moneda}`);
            console.log(`Stock: ${producto.stock}`);
            console.log(
                `Disponible: ${producto.disponible ? "Sí" : "No"}`
            );
            console.log(`Marca: ${producto.marca || "No especificada"}`);
            console.log(`Variantes: ${producto.variantes}`);
            console.log(`URL: ${producto.url}`);
            console.log(
                `Imágenes: ${producto.imagenes.length}`
            );
            console.log("------------------------------------------");
        });

        // Crear carpeta data si no existe
        fs.mkdirSync(OUTPUT_DIR, {
            recursive: true
        });

        const output = {
            fuente: "Centro3D",
            url: SHOP_URL,
            categoria: "filamentos",
            fecha_extraccion: new Date().toISOString(),
            total_api: totalEsperado,
            total_extraidos: productos.length,
            productos
        };

        fs.writeFileSync(
            OUTPUT_FILE,
            JSON.stringify(output, null, 2),
            "utf-8"
        );

        console.log("");
        console.log("==========================================");
        console.log("SCRAPING TERMINADO");
        console.log("==========================================");
        console.log("");
        console.log(`JSON guardado en:`);
        console.log(OUTPUT_FILE);
        console.log("");
    } catch (error) {
        console.error("");
        console.error("==========================================");
        console.error("ERROR");
        console.error("==========================================");
        console.error("");
        console.error(error);
        console.error("");
    } finally {
        await browser.close();
    }
}

main().catch((error) => {
    console.error("Error fatal:", error);
    process.exit(1);
});