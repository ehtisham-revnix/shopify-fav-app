import { json } from "@remix-run/node";
import { sessionStorage } from "../shopify.server";

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
        message: "Remove metafields endpoint is working",
        timestamp: new Date().toISOString(),
        url: request.url,
        method: request.method,
      },
      { headers }
    );
  } catch (error) {
    console.error("[remove-metafields][GET] Error:", error);
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

    const { customerId, productHandle, shop } = body;

    if (!customerId) throw new Error("Missing required field: customerId");
    if (!productHandle) throw new Error("Missing required field: productHandle");
    if (!shop) throw new Error("Missing required field: shop");

    const shopDomain = shop.includes(".myshopify.com") ? shop : `${shop}.myshopify.com`;
    const sessions = await sessionStorage.findSessionsByShop(shopDomain);

    if (!sessions || sessions.length === 0) {
      throw new Error(`No active session found for shop: ${shopDomain}`);
    }

    const session = sessions[0];
    const graphqlUrl = `https://${shopDomain}/admin/api/2024-01/graphql.json`;

    // Step 1: Determine the namespace (using same as update-metafields)
    const metafieldNamespace = "favorite"; // or "favorites" - match your existing namespace

    // Step 2: Fetch existing metafield value first
    const getMetafieldQuery = `
      query {
        customer(id: "${customerId}") {
          metafield(namespace: "${metafieldNamespace}", key: "favorite_products") {
            id
            value
            type
          }
        }
      }
    `;

    const getMetafieldResponse = await fetch(graphqlUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": session.accessToken,
      },
      body: JSON.stringify({ query: getMetafieldQuery }),
    });

    const getMetafieldResult = await getMetafieldResponse.json();
    console.log(`[remove-metafields] Existing metafield response:`, JSON.stringify(getMetafieldResult, null, 2));
    
    // Check for protected customer data access error
    if (getMetafieldResult.errors) {
      const accessDeniedError = getMetafieldResult.errors.find(error => 
        error.extensions?.code === "ACCESS_DENIED" && 
        error.message.includes("protected customer data")
      );
      
      if (accessDeniedError) {
        return json(
          {
            success: false,
            error: "Protected Customer Data Access Required",
            message: "This app needs to be approved for protected customer data access to manage customer metafields. Please apply for this access in your Shopify Partner Dashboard.",
            documentation: "https://shopify.dev/docs/apps/launch/protected-customer-data",
            developerNote: "For development, consider using app metafields or session storage as alternatives.",
            shopifyError: accessDeniedError
          },
          { status: 403, headers }
        );
      }
    }
    
    const existingMetafield = getMetafieldResult?.data?.customer?.metafield;

    if (!existingMetafield || !existingMetafield.value) {
      return json(
        {
          success: false,
          error: "No favorite products found for this customer",
          customerId: customerId,
          productHandle: productHandle
        },
        { status: 404, headers }
      );
    }

    // Step 3: Parse existing favorites and remove the specified product handle
    let currentFavorites = existingMetafield.value
      .split("\n")
      .map((v) => v.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);

    console.log(`[remove-metafields] Current favorites:`, currentFavorites);
    console.log(`[remove-metafields] Removing product handle:`, productHandle);

    // Check if the product handle exists in favorites
    if (!currentFavorites.includes(productHandle)) {
      return json(
        {
          success: false,
          error: "Product handle not found in favorites",
          customerId: customerId,
          productHandle: productHandle,
          currentFavorites: currentFavorites
        },
        { status: 404, headers }
      );
    }

    // Remove the product handle from favorites
    const updatedFavorites = currentFavorites.filter(handle => handle !== productHandle);
    console.log(`[remove-metafields] Updated favorites:`, updatedFavorites);

    // Step 4: Update the metafield with the new list (or delete if empty)
    let mutation;
    let variables;

    if (updatedFavorites.length === 0) {
      // If no favorites left, delete the metafield
      mutation = `
        mutation metafieldDelete($input: MetafieldDeleteInput!) {
          metafieldDelete(input: $input) {
            deletedId
            userErrors {
              field
              message
            }
          }
        }
      `;

      variables = {
        input: {
          id: existingMetafield.id
        }
      };
    } else {
      // Update the metafield with remaining favorites
      mutation = `
        mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields {
              id
              namespace
              key
              value
              type
            }
            userErrors {
              field
              message
            }
          }
        }
      `;

      variables = {
        metafields: [
          {
            ownerId: customerId,
            namespace: metafieldNamespace,
            key: "favorite_products",
            type: "multi_line_text_field",
            value: updatedFavorites.join("\n"),
          },
        ],
      };
    }

    console.log(`[remove-metafields] GraphQL variables:`, JSON.stringify(variables, null, 2));

    const response = await fetch(graphqlUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": session.accessToken,
      },
      body: JSON.stringify({ query: mutation, variables }),
    });

    console.log(`[remove-metafields] GraphQL response status:`, response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.log(`[remove-metafields] GraphQL error response:`, errorText);
      throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    console.log(`[remove-metafields] GraphQL result:`, JSON.stringify(result, null, 2));

    if (result.errors) {
      const accessDeniedError = result.errors.find(error => 
        error.extensions?.code === "ACCESS_DENIED" && 
        error.message.includes("protected customer data")
      );
      
      if (accessDeniedError) {
        return json(
          {
            success: false,
            error: "Protected Customer Data Access Required",
            message: "This app needs to be approved for protected customer data access to manage customer metafields. Please apply for this access in your Shopify Partner Dashboard.",
            documentation: "https://shopify.dev/docs/apps/launch/protected-customer-data",
            developerNote: "For development, consider using app metafields or session storage as alternatives.",
            shopifyError: accessDeniedError
          },
          { status: 403, headers }
        );
      }
      
      return json({ success: false, errors: result.errors }, { status: 400, headers });
    }

    const userErrors = result.data?.metafieldsSet?.userErrors || result.data?.metafieldDelete?.userErrors || [];
    if (userErrors.length > 0) {
      return json({ success: false, errors: userErrors }, { status: 400, headers });
    }

    // Verify the change by querying back
    console.log(`[remove-metafields] Verifying metafield was updated...`);
    const verifyQuery = `
      query {
        customer(id: "${customerId}") {
          metafield(namespace: "${metafieldNamespace}", key: "favorite_products") {
            id
            value
            type
            updatedAt
          }
        }
      }
    `;

    const verifyResponse = await fetch(graphqlUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": session.accessToken,
      },
      body: JSON.stringify({ query: verifyQuery }),
    });

    const verifyResult = await verifyResponse.json();
    console.log(`[remove-metafields] Verification result:`, JSON.stringify(verifyResult, null, 2));

    const responseMessage = updatedFavorites.length === 0 
      ? `Successfully removed "${productHandle}" from favorites. All favorites cleared.`
      : `Successfully removed "${productHandle}" from favorites. ${updatedFavorites.length} favorites remaining.`;

    return json(
      {
        success: true,
        message: responseMessage,
        removedProductHandle: productHandle,
        previousFavoritesCount: currentFavorites.length,
        currentFavoritesCount: updatedFavorites.length,
        remainingFavorites: updatedFavorites,
        deleted: updatedFavorites.length === 0,
        verificationResult: verifyResult,
        data: result,
      },
      { headers }
    );
  } catch (error) {
    console.error("[remove-metafields][POST] Error:", error);
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
