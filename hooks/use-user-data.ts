"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { doc, onSnapshot, Timestamp } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { UserData, UserDataFormData, IdentityEntity, IdentityEntityFormData } from "@/types/user-data";
import {
  generateEntityId,
  isPartnerLinkedToIdentity as checkPartnerLinked,
} from "@/lib/operations";
import { useAuth } from "@/components/auth";
import { callFunction } from "@/lib/firebase/callable";

/**
 * Migrate old format user data to new format with entities.
 * Called on read - transforms data in memory without saving.
 */
function migrateUserDataFormat(data: Partial<UserData>): UserData {
  // Already has personalEntity - already migrated
  if (data.personalEntity) {
    return data as UserData;
  }

  // No data at all - return as-is
  if (!data.name && !data.companyName && !data.aliases?.length) {
    return data as UserData;
  }

  const now = Timestamp.now();

  // Create personal entity from old format
  const personalEntity: IdentityEntity = {
    id: data.identityPartnerIds?.name ? `migrated_${data.identityPartnerIds.name}` : generateEntityId(),
    type: "person",
    name: data.name || "",
    aliases: data.aliases || [],
    vatId: data.vatIds?.[0],
    ibans: data.ibans || [],
    partnerId: data.identityPartnerIds?.name,
    order: 0,
    createdAt: data.createdAt || now,
  };

  // Create company entity from old format (if companyName exists)
  const companies: IdentityEntity[] = [];
  if (data.companyName) {
    companies.push({
      id: data.identityPartnerIds?.companyName ? `migrated_${data.identityPartnerIds.companyName}` : generateEntityId(),
      type: "company",
      name: data.companyName,
      aliases: [],
      vatId: data.vatIds?.[1], // Second VAT ID goes to company
      ibans: [],
      partnerId: data.identityPartnerIds?.companyName,
      order: 0,
      createdAt: data.createdAt || now,
    });
  }

  return {
    ...data,
    personalEntity,
    companies,
    updatedAt: data.updatedAt || now,
    createdAt: data.createdAt || now,
  } as UserData;
}

/** An entity as the saveIdentity callable takes it: the form's fields, not the stored ones (createdAt). */
function toEntityRequest(e: IdentityEntityFormData): IdentityEntityFormData {
  const { id, type, name, aliases, vatId, ibans, address, partnerId, order } = e;
  return { id, type, name, aliases, vatId, ibans, address, partnerId, order };
}

/** The request saveIdentity takes; it refuses fields the identity does not hold. */
function toIdentityRequest(data: UserDataFormData): UserDataFormData {
  return {
    ...data,
    personalEntity: data.personalEntity ? toEntityRequest(data.personalEntity) : undefined,
    companies: data.companies?.map(toEntityRequest),
  };
}

/**
 * Hook for managing user data (identity entities)
 * Used for extraction prompts and invoice direction detection
 */
export function useUserData() {
  const { userId } = useAuth();
  const [userData, setUserData] = useState<UserData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Realtime listener for user data
  useEffect(() => {
    if (!userId) {
      setUserData(null);
      setLoading(false);
      return;
    }

    setLoading(true);

    const docRef = doc(db, "users", userId, "settings", "userData");

    const unsubscribe = onSnapshot(
      docRef,
      (snapshot) => {
        if (snapshot.exists()) {
          // Migrate old format to new format on read
          const rawData = snapshot.data() as Partial<UserData>;
          const migratedData = migrateUserDataFormat(rawData);
          setUserData(migratedData);
        } else {
          setUserData(null);
        }
        setLoading(false);
      },
      (err) => {
        console.error("Error fetching user data:", err);
        setError(err);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [userId]);

  /**
   * Save user data. The server's identity module normalises and writes it (#632).
   */
  const save = useCallback(
    async (data: UserDataFormData): Promise<void> => {
      setSaving(true);
      setError(null);
      try {
        await callFunction("saveIdentity", toIdentityRequest(data));
      } catch (err) {
        setError(err as Error);
        throw err;
      } finally {
        setSaving(false);
      }
    },
    []
  );

  /**
   * Check if user data is configured (has at least personal name or a company)
   */
  const isConfigured = useMemo(() => {
    if (!userData) return false;

    // New format check
    if (userData.personalEntity?.name || (userData.companies?.length ?? 0) > 0) {
      return true;
    }

    // Legacy format check
    return !!(userData.name || userData.companyName);
  }, [userData]);

  /**
   * Check if a partner is marked as "this is my company" (legacy)
   * or linked to an identity entity (new format)
   */
  const isPartnerMarkedAsMe = useCallback(
    (partnerId: string): boolean => {
      if (!userData) return false;

      // Check new format first
      if (checkPartnerLinked(userData, partnerId)) {
        return true;
      }

      // Legacy format
      return userData.markedAsMe?.includes(partnerId) ?? false;
    },
    [userData]
  );

  /**
   * Get list of partner IDs marked as "me"
   */
  const markedAsMe = useMemo(() => {
    return userData?.markedAsMe ?? [];
  }, [userData?.markedAsMe]);

  // ============================================================================
  // Entity Management Functions
  // ============================================================================

  /**
   * Add a new company entity
   */
  const addCompany = useCallback(
    async (company: Omit<IdentityEntityFormData, "id" | "type">): Promise<string> => {
      if (!userData) throw new Error("User data not loaded");

      const newCompany: IdentityEntityFormData = {
        ...company,
        id: generateEntityId(),
        type: "company",
        order: (userData.companies?.length ?? 0),
      };

      await save({
        country: userData.country,
        taxNumber: userData.taxNumber,
        ownEmails: userData.ownEmails,
        personalEntity: userData.personalEntity ? {
          ...userData.personalEntity,
          type: "person",
        } : undefined,
        companies: [
          ...(userData.companies?.map(c => ({ ...c, type: "company" as const })) || []),
          newCompany,
        ],
      });

      return newCompany.id!;
    },
    [userData, save]
  );

  /**
   * Update the personal entity
   */
  const updatePersonalEntity = useCallback(
    async (updates: Partial<IdentityEntityFormData>): Promise<void> => {
      if (!userData?.personalEntity) throw new Error("Personal entity not found");

      await save({
        country: userData.country,
        taxNumber: userData.taxNumber,
        ownEmails: userData.ownEmails,
        personalEntity: {
          ...userData.personalEntity,
          ...updates,
          type: "person",
        },
        companies: userData.companies?.map(c => ({ ...c, type: "company" as const })),
      });
    },
    [userData, save]
  );

  /**
   * Update a company entity by ID
   */
  const updateCompany = useCallback(
    async (companyId: string, updates: Partial<IdentityEntityFormData>): Promise<void> => {
      if (!userData?.companies) throw new Error("No companies found");

      const companyIndex = userData.companies.findIndex(c => c.id === companyId);
      if (companyIndex === -1) throw new Error("Company not found");

      const updatedCompanies = [...userData.companies];
      updatedCompanies[companyIndex] = {
        ...updatedCompanies[companyIndex],
        ...updates,
        type: "company",
      };

      await save({
        country: userData.country,
        taxNumber: userData.taxNumber,
        ownEmails: userData.ownEmails,
        personalEntity: userData.personalEntity ? {
          ...userData.personalEntity,
          type: "person",
        } : undefined,
        companies: updatedCompanies.map(c => ({ ...c, type: "company" as const })),
      });
    },
    [userData, save]
  );

  /**
   * Delete a company entity and its linked partner
   */
  const deleteCompany = useCallback(
    async (companyId: string): Promise<void> => {
      if (!userData?.companies) throw new Error("No companies found");

      const company = userData.companies.find(c => c.id === companyId);
      if (!company) throw new Error("Company not found");

      // Delete linked partner if exists
      if (company.partnerId) {
        try {
          await callFunction("deleteUserPartner", { partnerId: company.partnerId });
        } catch (err) {
          console.error("Failed to delete linked partner:", err);
          // Continue with company deletion even if partner delete fails
        }
      }

      await save({
        country: userData.country,
        taxNumber: userData.taxNumber,
        ownEmails: userData.ownEmails,
        personalEntity: userData.personalEntity ? {
          ...userData.personalEntity,
          type: "person",
        } : undefined,
        companies: userData.companies
          .filter(c => c.id !== companyId)
          .map(c => ({ ...c, type: "company" as const })),
      });
    },
    [userData, save]
  );

  /**
   * Check if a partner is linked to any identity entity
   */
  const isPartnerLinkedToIdentity = useCallback(
    (partnerId: string): boolean => {
      return checkPartnerLinked(userData, partnerId);
    },
    [userData]
  );

  return {
    userData,
    loading,
    saving,
    error,
    save,
    isConfigured,
    isPartnerMarkedAsMe,
    markedAsMe,
    // Entity management
    addCompany,
    updatePersonalEntity,
    updateCompany,
    deleteCompany,
    isPartnerLinkedToIdentity,
  };
}
