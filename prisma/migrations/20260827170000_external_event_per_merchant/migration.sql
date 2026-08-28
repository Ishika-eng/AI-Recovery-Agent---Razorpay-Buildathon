-- Scope the ExternalEvent idempotency key per merchant instead of globally.
DROP INDEX "ExternalEvent_provider_externalEventId_key";
CREATE UNIQUE INDEX "ExternalEvent_merchantId_provider_externalEventId_key" ON "ExternalEvent"("merchantId", "provider", "externalEventId");
