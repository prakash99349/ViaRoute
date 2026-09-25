-- Pay as you go only: one plan with no monthly fee; every customer moves to it and the old plans are removed.
INSERT INTO "Plan" ("id", "code", "name", "monthlyPrice", "perMinuteRate", "includedNumbers", "maxUsers", "whiteLabel", "customDomain", "active")
VALUES (gen_random_uuid(), 'payg', 'Pay as you go', 0, 0.025, 0, NULL, true, true, true)
ON CONFLICT ("code") DO NOTHING;

UPDATE "Tenant" SET "planId" = (SELECT "id" FROM "Plan" WHERE "code" = 'payg');

DELETE FROM "Plan" WHERE "code" <> 'payg';
