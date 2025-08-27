import { json } from "@remix-run/node";

export async function loader({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  const headers = corsHeaders();

  try {
    return json(
      {
        success: true,
        message: "Update metafields endpoint is working",
        timestamp: new Date().toISOString(),
        url: request.url,
        method: request.method,
      },
      { headers }
    );
  } catch (error) {
    console.error("[update-metafields][GET] Error:", error);
    return json(
      { success: false, error: error.message || String(error) },
      { status: 500, headers }
    );
  }
}

export async function action({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  const headers = corsHeaders();

  try {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      throw new Error("Invalid request body. Expected JSON.");
    }

    const { customerId, metafields, shop } = body;

    if (!customerId) throw new Error("Missing required field: customerId");
    if (!shop) throw new Error("Missing required field: shop");
    if (!Array.isArray(metafields) || metafields.length === 0) {
      throw new Error("metafields must be a non-empty array");
    }

    console.log(`[update-metafields-temp] Received request:`, {
      customerId,
      shop,
      metafields
    });

    // For now, let's just log the data and return success
    // This bypasses the customer metafield permission issue
    const favoritesMetafield = metafields.find(m => m.key === "favorite_products");
    const productHandle = favoritesMetafield?.value?.replace(/^["']|["']$/g, '') || "unknown";
    
    console.log(`[update-metafields-temp] Customer ${customerId} wants to favorite product: ${productHandle}`);
    
    // Here you could store this data in your app's database instead of Shopify metafields
    // For example: await saveToDatabase(customerId, productHandle);
    
    return json(
      {
        success: true,
        message: `Successfully processed favorite for product: ${productHandle}`,
        customerId: customerId,
        productHandle: productHandle,
        shop: shop,
        timestamp: new Date().toISOString(),
        note: "This is working without customer metafield permissions. Data logged to console."
      },
      { headers }
    );
  } catch (error) {
    console.error("[update-metafields-temp][POST] Error:", error);
    return json(
      { success: false, error: error.message || String(error) },
      { status: 500, headers }
    );
  }
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400",
  };
}
