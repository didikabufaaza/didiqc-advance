-- ============================================================
-- Migration: Peer Group PME/PMI Module
-- Standard PostgreSQL (Compatible with NeonDB, InsForge, Supabase)
-- ============================================================

-- 1. Table peer_group_config
CREATE TABLE IF NOT EXISTS "peer_group_config" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "parameter" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "startDate" TEXT NOT NULL,
    "endDate" TEXT NOT NULL,
    "aggregationRule" TEXT NOT NULL DEFAULT 'latest',
    "singleDate" TEXT,
    "targetType" TEXT NOT NULL DEFAULT 'robust_mean',
    "assignedValue" DOUBLE PRECISION,
    "assignedValueSource" TEXT,
    "sdpaType" TEXT NOT NULL DEFAULT 'robust_sd',
    "sdpaValue" DOUBLE PRECISION,
    "sdpaSource" TEXT,
    "selectedHospitals" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdBy" TEXT NOT NULL,
    "createdDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "peer_group_config_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "peer_group_config_parameter_idx" ON "peer_group_config"("parameter");
CREATE INDEX IF NOT EXISTS "peer_group_config_startDate_endDate_idx" ON "peer_group_config"("startDate", "endDate");
CREATE INDEX IF NOT EXISTS "peer_group_config_status_idx" ON "peer_group_config"("status");

-- 2. Table peer_group_summary_stats
CREATE TABLE IF NOT EXISTS "peer_group_summary_stats" (
    "id" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "totalSelected" INTEGER NOT NULL,
    "totalWithData" INTEGER NOT NULL,
    "totalValid" INTEGER NOT NULL,
    "totalExcluded" INTEGER NOT NULL,
    "mean" DOUBLE PRECISION,
    "median" DOUBLE PRECISION,
    "sd" DOUBLE PRECISION,
    "cv" DOUBLE PRECISION,
    "min" DOUBLE PRECISION,
    "max" DOUBLE PRECISION,
    "range" DOUBLE PRECISION,
    "q1" DOUBLE PRECISION,
    "q3" DOUBLE PRECISION,
    "iqr" DOUBLE PRECISION,
    "mad" DOUBLE PRECISION,
    "robustMean" DOUBLE PRECISION,
    "robustSd" DOUBLE PRECISION,
    "niqr" DOUBLE PRECISION,
    "uncertainty" DOUBLE PRECISION,
    "targetValue" DOUBLE PRECISION,
    "targetSource" TEXT,
    "sdpaValue" DOUBLE PRECISION,
    "sdpaSource" TEXT,
    "statStatus" TEXT NOT NULL,
    "notes" TEXT,
    "createdDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "peer_group_summary_stats_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "peer_group_summary_stats_configId_key" ON "peer_group_summary_stats"("configId");
CREATE INDEX IF NOT EXISTS "peer_group_summary_stats_configId_idx" ON "peer_group_summary_stats"("configId");

-- 3. Table peer_group_snapshot_item
CREATE TABLE IF NOT EXISTS "peer_group_snapshot_item" (
    "id" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "hospitalUsername" TEXT NOT NULL,
    "hospitalName" TEXT NOT NULL,
    "parameter" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "unit" TEXT,
    "analyzer" TEXT,
    "method" TEXT,
    "controlLot" TEXT,
    "reagentLot" TEXT,
    "originalQcValue" DOUBLE PRECISION,
    "usedQcValue" DOUBLE PRECISION,
    "sourceCount" INTEGER NOT NULL DEFAULT 1,
    "date" TEXT,
    "diffTarget" DOUBLE PRECISION,
    "zScore" DOUBLE PRECISION,
    "zScoreAbs" DOUBLE PRECISION,
    "peerRelativeScore" DOUBLE PRECISION,
    "peerRelativeAbs" DOUBLE PRECISION,
    "evalCategory" TEXT,
    "biasAbs" DOUBLE PRECISION,
    "biasPct" DOUBLE PRECISION,
    "cvLab" DOUBLE PRECISION,
    "tea" DOUBLE PRECISION,
    "teaSource" TEXT,
    "sigma" DOUBLE PRECISION,
    "sigmaCategory" TEXT,
    "isValid" BOOLEAN NOT NULL DEFAULT true,
    "validationStatus" TEXT NOT NULL DEFAULT 'valid',
    "exclusionReason" TEXT,
    "recommendation" TEXT,

    CONSTRAINT "peer_group_snapshot_item_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "peer_group_snapshot_item_configId_idx" ON "peer_group_snapshot_item"("configId");
CREATE INDEX IF NOT EXISTS "peer_group_snapshot_item_hospitalUsername_idx" ON "peer_group_snapshot_item"("hospitalUsername");
CREATE INDEX IF NOT EXISTS "peer_group_snapshot_item_configId_hospitalUsername_idx" ON "peer_group_snapshot_item"("configId", "hospitalUsername");

-- 4. Table peer_group_report_delivery
CREATE TABLE IF NOT EXISTS "peer_group_report_delivery" (
    "id" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "recipientUsername" TEXT NOT NULL,
    "recipientName" TEXT NOT NULL,
    "sentBy" TEXT NOT NULL,
    "sentDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'sent',
    "readDate" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "summarySnapshot" TEXT,
    "itemSnapshot" TEXT,

    CONSTRAINT "peer_group_report_delivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "peer_group_report_delivery_configId_idx" ON "peer_group_report_delivery"("configId");
CREATE INDEX IF NOT EXISTS "peer_group_report_delivery_recipientUsername_idx" ON "peer_group_report_delivery"("recipientUsername");
CREATE INDEX IF NOT EXISTS "peer_group_report_delivery_status_idx" ON "peer_group_report_delivery"("status");
