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

    const shopDomain = shop.includes(".myshopify.com") ? shop : `${shop}.myshopify.com`;
    const sessions = await sessionStorage.findSessionsByShop(shopDomain);

    if (!sessions || sessions.length === 0) {
      throw new Error(`No active session found for shop: ${shopDomain}`);
    }

    const session = sessions[0];
    const graphqlUrl = `https://${shopDomain}/admin/api/2024-01/graphql.json`;

    // Step 1: Determine the namespace from the request
    let metafieldNamespace = "favorites"; // default
    const favoritesMetafield = metafields.find(m => m.key === "favorite_products");
    if (favoritesMetafield?.namespace) {
      metafieldNamespace = favoritesMetafield.namespace;
    }
    console.log(`[update-metafields] Using namespace: ${metafieldNamespace}`);

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
    console.log(`[update-metafields] Existing metafield response:`, JSON.stringify(getMetafieldResult, null, 2));
    
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

    // Step 2: Parse existing favorites
    let currentFavorites = [];
    if (existingMetafield?.value) {
      currentFavorites = existingMetafield.value
        .split("\n")
        .map((v) => v.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    }
    console.log(`[update-metafields] Current favorites:`, currentFavorites);

    // Step 3: Get new favorites from request
    const allNewFavorites = [];
    metafields.forEach(metafield => {
      console.log(`[update-metafields] Processing metafield:`, metafield);
      if (metafield.key === "favorite_products" && metafield.value) {
        let cleanValue = metafield.value;
        
        // Clean up the value - remove extra quotes and parse properly
        if (typeof cleanValue === 'string') {
          // Remove surrounding quotes if they exist
          cleanValue = cleanValue.replace(/^["']|["']$/g, '');
          console.log(`[update-metafields] Cleaned value:`, cleanValue);
        }
        
        const newValues = typeof cleanValue === 'string' 
          ? cleanValue.split("\n").map(v => v.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
          : Array.isArray(cleanValue) 
            ? cleanValue.map(v => String(v).trim().replace(/^["']|["']$/g, '')).filter(Boolean)
            : [String(cleanValue).trim().replace(/^["']|["']$/g, '')].filter(Boolean);
        console.log(`[update-metafields] New values to add:`, newValues);
        allNewFavorites.push(...newValues);
      }
    });

    // Step 4: Merge existing + new (remove duplicates)
    const mergedFavorites = Array.from(new Set([...currentFavorites, ...allNewFavorites]));
    console.log(`[update-metafields] Merged favorites:`, mergedFavorites);

    // Check if we actually have data to save
    if (mergedFavorites.length === 0) {
      return json(
        {
          success: false,
          error: "No valid product handles found after processing",
          receivedMetafields: metafields,
          processedValues: allNewFavorites
        },
        { status: 400, headers }
      );
    }

    // Step 5: Create the final metafield structure
    const validatedMetafields = [
      {
        namespace: metafieldNamespace,
        key: "favorite_products",
        type: "multi_line_text_field",
        value: mergedFavorites.join("\n"),
      },
    ];

    console.log(`[update-metafields] Final validated metafields:`, JSON.stringify(validatedMetafields, null, 2));

    const mutation = `
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

    const variables = {
      metafields: [
        {
          ownerId: customerId,
          namespace: metafieldNamespace,
          key: "favorite_products",
          type: "multi_line_text_field",
          value: mergedFavorites.join("\n"),
        },
      ],
    };

    console.log(`[update-metafields] GraphQL variables:`, JSON.stringify(variables, null, 2));

    const response = await fetch(graphqlUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": session.accessToken,
      },
      body: JSON.stringify({ query: mutation, variables }),
    });

    console.log(`[update-metafields] GraphQL response status:`, response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.log(`[update-metafields] GraphQL error response:`, errorText);
      throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    console.log(`[update-metafields] GraphQL result:`, JSON.stringify(result, null, 2));

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

    const userErrors = result.data?.metafieldsSet?.userErrors || [];
    if (userErrors.length > 0) {
      return json({ success: false, errors: userErrors }, { status: 400, headers });
    }

    const createdMetafields = result.data?.metafieldsSet?.metafields || [];

    // Verify the metafield was actually saved by querying it back
    console.log(`[update-metafields] Verifying metafield was saved...`);
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
    console.log(`[update-metafields] Verification result:`, JSON.stringify(verifyResult, null, 2));

    return json(
      {
        success: true,
        message: `Successfully added ${allNewFavorites.length} new favorites to existing ${currentFavorites.length}. Total: ${mergedFavorites.length}`,
        existingFavoritesCount: currentFavorites.length,
        newFavoritesAdded: allNewFavorites.length,
        totalFavoritesCount: mergedFavorites.length,
        allFavorites: mergedFavorites,
        createdMetafields: createdMetafields,
        verificationResult: verifyResult,
        data: result,
        updatedMetafields: createdMetafields.length,
      },
      { headers }
    );
  } catch (error) {
    console.error("[update-metafields][POST] Error:", error);
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
