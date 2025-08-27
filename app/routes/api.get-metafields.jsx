import { json } from "@remix-run/node";
import { sessionStorage } from "../shopify.server";

export async function loader({ request }) {
  const headers = corsHeaders();

  try {
    const url = new URL(request.url);
    const customerId = url.searchParams.get("customerId");
    const shop = url.searchParams.get("shop");

    if (!customerId) throw new Error("Missing required parameter: customerId");
    if (!shop) throw new Error("Missing required parameter: shop");

    const shopDomain = shop.includes(".myshopify.com") ? shop : `${shop}.myshopify.com`;
    const sessions = await sessionStorage.findSessionsByShop(shopDomain);

    if (!sessions || sessions.length === 0) {
      throw new Error(`No active session found for shop: ${shopDomain}`);
    }

    const session = sessions[0];
    const graphqlUrl = `https://${shopDomain}/admin/api/2024-01/graphql.json`;

    // Query to get ALL metafields for this customer
    const query = `
      query {
        customer(id: "${customerId}") {
          id
          email
          firstName
          lastName
          metafields(first: 50) {
            edges {
              node {
                id
                namespace
                key
                value
                type
                createdAt
                updatedAt
              }
            }
          }
          metafield(namespace: "favorites", key: "favorite_products") {
            id
            namespace
            key
            value
            type
            createdAt
            updatedAt
          }
        }
      }
    `;

    console.log(`[get-metafields] Querying customer: ${customerId}`);

    const response = await fetch(graphqlUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": session.accessToken,
      },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) {
      throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    console.log(`[get-metafields] Full result:`, JSON.stringify(result, null, 2));

    if (result.errors) {
      return json({ success: false, errors: result.errors }, { status: 400, headers });
    }

    const customer = result.data?.customer;
    if (!customer) {
      return json({ success: false, error: "Customer not found" }, { status: 404, headers });
    }

    const allMetafields = customer.metafields?.edges?.map(edge => edge.node) || [];
    const favoritesMetafield = customer.metafield;

    return json(
      {
        success: true,
        customer: {
          id: customer.id,
          email: customer.email,
          firstName: customer.firstName,
          lastName: customer.lastName,
        },
        favoritesMetafield: favoritesMetafield,
        allMetafields: allMetafields,
        totalMetafields: allMetafields.length,
        favoritesExists: !!favoritesMetafield,
        favoriteProducts: favoritesMetafield?.value ? favoritesMetafield.value.split('\n').filter(Boolean) : [],
      },
      { headers }
    );
  } catch (error) {
    console.error("[get-metafields] Error:", error);
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
