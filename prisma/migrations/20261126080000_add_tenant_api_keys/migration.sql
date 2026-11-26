-- Add hashed API key storage for tenant authentication.
ALTER TABLE "Tenant" ADD COLUMN "apiKeyHash" TEXT;

-- A tenant API key hash must identify at most one tenant.
CREATE UNIQUE INDEX "Tenant_apiKeyHash_key" ON "Tenant"("apiKeyHash");
