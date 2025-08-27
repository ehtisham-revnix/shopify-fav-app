import {
  Link,
  Outlet,
  useLoaderData,
  useRouteError,
} from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { authenticate } from "../shopify.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const accessToken = session.accessToken;

  // --- 1. Ensure customer metafield definition exists ---
  try {
    const checkResponse = await admin.graphql(`
      query {
        metafieldDefinitions(namespace: "favorite", ownerType: CUSTOMER, first: 1) {
          edges {
            node {
              id
              name
              key
            }
          }
        }
      }
    `);

    const { data: checkData, errors: checkErrors } = await checkResponse.json();

    const existingDefinitions = checkData?.metafieldDefinitions?.edges || [];
    const alreadyExists = existingDefinitions.some(
      (edge) => edge.node.key === "favorite_products"
    );

    if (!alreadyExists) {
      console.log("Creating customer metafield definition...");

      const createResponse = await admin.graphql(
        `
        mutation CreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
          metafieldDefinitionCreate(definition: $definition) {
            createdDefinition {
              id
              name
            }
            userErrors {
              field
              message
              code
            }
          }
        }
      `,
        {
          variables: {
            definition: {
              name: "Favorite Products",
              namespace: "favorite",
              key: "favorite_products",
              description: "A list of favorite products.",
              type: "multi_line_text_field",
              ownerType: "CUSTOMER",
            },
          },
        }
      );

      const { data: createData, errors: createErrors } = await createResponse.json();
      const userErrors = createData?.metafieldDefinitionCreate?.userErrors || [];

      if (createErrors?.length || userErrors.length) {
        console.error("Failed to create metafield definition:", {
          createErrors,
          userErrors,
        });
      } else {
        console.log("✅ Metafield definition created:", createData?.metafieldDefinitionCreate?.createdDefinition);
      }
    } else {
      console.log("✅ Metafield definition already exists.");
    }
  } catch (err) {
    console.error("❌ Error checking/creating metafield definition:", err);
  }

  // --- 2. Register ScriptTag using GraphQL ---
  // ScriptTag registration temporarily removed to avoid permission errors
  
  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    accessToken, // ⚠️ Only for development
  };
};

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        <Link to="/app" rel="home">Home</Link>
        <Link to="/app/additional">Additional Page</Link>
      </NavMenu>
      <Outlet />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
