"use client";

import { useMemo, useCallback, useState } from "react";
import { useEmailIntegrations } from "./use-email-integrations";
import { useBrowserExtensionStatus } from "./use-browser-extension";
import {
  getAllPipelines,
  getPipelineById,
  getStepById,
} from "@/lib/automations";
import type {
  AutomationPipeline,
  AutomationStep,
  IntegrationStatus,
  PipelineId,
} from "@/types/automation";

export interface UseAutomationsResult {
  /** All automation pipelines */
  pipelines: AutomationPipeline[];
  /** Get a specific pipeline by ID */
  getPipeline: (id: PipelineId) => AutomationPipeline | undefined;
  /** Get a specific step by ID */
  getStep: (stepId: string) => AutomationStep | undefined;
  /** Get integration statuses map */
  integrationStatuses: Map<string, IntegrationStatus>;
  /** Check if a specific integration is connected */
  isIntegrationConnected: (integrationId: string | null) => boolean;
  /** Get integrations that need attention (not connected, needs reauth, or paused) */
  integrationIssues: IntegrationStatus[];
  /** Whether any integrations have issues */
  hasIntegrationIssues: boolean;
  /** Loading state for integration data */
  loading: boolean;
  /** Currently open automation dialog pipeline ID */
  openPipelineId: PipelineId | null;
  /** Open the automation dialog for a pipeline */
  openAutomationDialog: (pipelineId: PipelineId) => void;
  /** Close the automation dialog */
  closeAutomationDialog: () => void;
  /** Browser extension status */
  browserExtensionStatus: "checking" | "installed" | "not_installed";
  /** Check browser extension status manually */
  checkBrowserExtension: () => void;
  /** Whether Gmail is connected */
  hasGmailIntegration: boolean;
  /** Connect Gmail handler */
  connectGmail: () => Promise<void>;
}

export function useAutomations(): UseAutomationsResult {
  const { integrations, loading, hasGmailIntegration, connectGmail } = useEmailIntegrations();
  const { status: browserExtensionStatus, checkNow: checkBrowserExtension } = useBrowserExtensionStatus();
  const [openPipelineId, setOpenPipelineId] = useState<PipelineId | null>(null);

  // Build integration statuses from email integrations and browser extension
  const integrationStatuses = useMemo(() => {
    const statuses = new Map<string, IntegrationStatus>();

    // Gmail integration status
    const gmailIntegration = integrations.find((i) => i.provider === "gmail");
    statuses.set("gmail", {
      integrationId: "gmail",
      displayName: "Gmail",
      isConnected: !!gmailIntegration && gmailIntegration.isActive,
      needsReauth: gmailIntegration?.needsReauth ?? false,
      isPaused: gmailIntegration?.isPaused,
    });

    // Outlook integration status (if exists)
    const outlookIntegration = integrations.find(
      (i) => i.provider === "outlook"
    );
    statuses.set("outlook", {
      integrationId: "outlook",
      displayName: "Outlook",
      isConnected: !!outlookIntegration && outlookIntegration.isActive,
      needsReauth: outlookIntegration?.needsReauth ?? false,
      isPaused: outlookIntegration?.isPaused,
    });

    // Browser extension status
    statuses.set("browser", {
      integrationId: "browser",
      displayName: "Browser Extension",
      isConnected: browserExtensionStatus === "installed",
      needsReauth: false,
      isPaused: false,
    });

    return statuses;
  }, [integrations, browserExtensionStatus]);

  // Get all pipelines
  const pipelines = useMemo(() => getAllPipelines(), []);

  // Get a specific pipeline
  const getPipeline = useCallback(
    (id: PipelineId) => getPipelineById(id),
    []
  );

  // Get a specific step
  const getStep = useCallback((stepId: string) => getStepById(stepId), []);

  // Check if integration is connected
  const isIntegrationConnected = useCallback(
    (integrationId: string | null) => {
      if (!integrationId) return true; // System automations are always available
      const status = integrationStatuses.get(integrationId);
      return status?.isConnected ?? false;
    },
    [integrationStatuses]
  );

  // Get integrations that need attention
  const integrationIssues = useMemo(() => {
    const issues: IntegrationStatus[] = [];
    integrationStatuses.forEach((status) => {
      if (!status.isConnected || status.needsReauth || status.isPaused) {
        issues.push(status);
      }
    });
    return issues;
  }, [integrationStatuses]);

  // Dialog controls
  const openAutomationDialog = useCallback((pipelineId: PipelineId) => {
    setOpenPipelineId(pipelineId);
  }, []);

  const closeAutomationDialog = useCallback(() => {
    setOpenPipelineId(null);
  }, []);

  return {
    pipelines,
    getPipeline,
    getStep,
    integrationStatuses,
    isIntegrationConnected,
    integrationIssues,
    hasIntegrationIssues: integrationIssues.length > 0,
    loading,
    openPipelineId,
    openAutomationDialog,
    closeAutomationDialog,
    browserExtensionStatus,
    checkBrowserExtension,
    hasGmailIntegration,
    connectGmail,
  };
}
