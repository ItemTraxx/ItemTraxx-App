<template>
  <div class="page">
    <div class="page-nav-left">
      <RouterLink class="button-link" to="/tenant/admin">Return to admin panel</RouterLink>
      <RouterLink class="button-link" to="/tenant/admin/gear-import">Bulk item import wizard</RouterLink>
    </div>
    <h1>Item Management</h1>
    <p>Add and manage items.</p>
    <p class="muted">Export item data to CSV or PDF from the list section.</p>

    <div class="card">
      <h2>Add Item</h2>
      <form class="form" @submit.prevent="handleCreate">
        <label>
          Name
          <input v-model="name" type="text" placeholder="Item name" />
        </label>
        <label>
          Barcode
          <input v-model="barcode" type="text" placeholder="Barcode" />
        </label>
        <label>
          Serial number
          <input v-model="serialNumber" type="text" placeholder="Serial number" />
        </label>
        <label>
          Notes
          <textarea
            v-model="notes"
            rows="3"
            placeholder="Optional notes"
            maxlength="500"
          ></textarea>
          <div class="muted form-help-row">
            <span>Character limit 500</span>
            <span>{{ notes.length }}/500</span>
          </div>
        </label>
        <button type="submit" class="button-primary" :disabled="isSaving">Add item</button>
      </form>
      <p v-if="error" class="error">{{ error }}</p>
      <p v-if="success" class="success">{{ success }}</p>
    </div>
    <div v-if="toastMessage" class="toast">
      <div class="toast-title">{{ toastTitle }}</div>
      <div class="toast-body">{{ toastMessage }}</div>
    </div>

    <div class="card">
      <h2>Item List</h2>
      <div class="form-grid-2">
        <label>
          Search items
          <input
            v-model="searchQuery"
            type="text"
            placeholder="Search by name, barcode, serial, status, or notes"
          />
        </label>
        <label>
          Filter status
          <select v-model="statusFilter">
            <option value="all">all statuses</option>
            <option v-for="option in statusOptions" :key="option" :value="option">
              {{ option }}
            </option>
          </select>
        </label>
      </div>
      <div class="form-actions">
        <button type="button" @click="exportCsv">Export CSV</button>
        <button type="button" @click="exportPdf">Export PDF</button>
      </div>
      <p class="muted">Showing {{ filteredGear.length }} of {{ gear.length }} items.</p>
      <p v-if="isLoading" class="muted">Loading items...</p>
      <table v-else class="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Barcode</th>
            <th>Serial</th>
            <th>Status</th>
            <th>Notes</th>
            <th></th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in filteredGear" :key="item.id">
            <td>
              <span v-if="editingId !== item.id">{{ item.name }}</span>
              <input v-else v-model="editName" type="text" placeholder="Name" />
            </td>
            <td>
              <span v-if="editingId !== item.id">{{ item.barcode }}</span>
              <input v-else v-model="editBarcode" type="text" placeholder="Barcode" />
            </td>
            <td>
              <span
                class="serial-number"
                :class="{ dim: editingId === item.id }"
                title="To edit the serial number, please contact support@itemtraxx.com with the current item serial number and what you would lke to change it to."
              >
                {{ item.serial_number || "-" }}
              </span>
            </td>
            <td>
              <span v-if="editingId !== item.id">{{ item.status }}</span>
              <select v-else v-model="editStatus">
                <option v-if="editStatus === 'checked_out'" value="checked_out" disabled>
                  checked_out (managed by checkout)
                </option>
                <option v-for="option in editableStatusOptions" :key="option" :value="option">
                  {{ option }}
                </option>
              </select>
            </td>
            <td class="gear-notes-cell">
              <span v-if="editingId !== item.id">{{ item.notes || "-" }}</span>
              <div v-else>
                <textarea
                  v-model="editNotes"
                  class="gear-notes-input"
                  rows="3"
                  maxlength="500"
                  placeholder="Notes"
                ></textarea>
                <div class="muted form-help-row">
                  <span>Character limit 500</span>
                  <span>{{ editNotes.length }}/500</span>
                </div>
              </div>
            </td>
            <td :class="{ 'edit-actions-cell': editingId === item.id }">
              <div class="admin-actions">
                <button
                  v-if="editingId !== item.id"
                  type="button"
                  class="link"
                  @click="startEdit(item)"
                >
                  Edit
                </button>
                <div v-else class="admin-actions">
                  <button type="button" class="link" @click="saveEdit(item.id)">Save</button>
                  <button type="button" class="link" @click="cancelEdit">Cancel</button>
                  <button type="button" class="link" @click="removeGear(item)">Archive</button>
                </div>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <h2>Archived Items</h2>
      <p class="muted">Archived items can be restored when needed.</p>
      <p v-if="isLoadingArchived" class="muted">Loading archived items...</p>
      <table v-else class="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Barcode</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in archivedGear" :key="item.id">
            <td>{{ item.name }}</td>
            <td>{{ item.barcode }}</td>
            <td>{{ item.status }}</td>
            <td>
              <button type="button" class="link" :disabled="isSaving" @click="handleRestore(item)">
                Restore
              </button>
            </td>
          </tr>
          <tr v-if="archivedGear.length === 0">
            <td colspan="4" class="muted">No archived items.</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { getAuthState } from "../../../store/authState";
import { logAdminAction } from "../../../services/auditLogService";
import { enforceAdminRateLimit } from "../../../services/rateLimitService";
import {
  createGear,
  deleteGear,
  fetchDeletedGear,
  fetchGear,
  restoreGear,
  updateGear,
  type GearItem,
} from "../../../services/gearService";
import { exportRowsToCsv, exportRowsToPdf } from "../../../services/exportService";
import { sanitizeInput } from "../../../utils/inputSanitizer";

const gear = ref<GearItem[]>([]);
const archivedGear = ref<GearItem[]>([]);
const isLoading = ref(false);
const isLoadingArchived = ref(false);
const isSaving = ref(false);
const error = ref("");
const success = ref("");
const toastTitle = ref("");
const toastMessage = ref("");

const name = ref("");
const barcode = ref("");
const serialNumber = ref("");
const notes = ref("");
const searchQuery = ref("");
const statusFilter = ref("all");
const statusOptions = [
  "available",
  "checked_out",
  "damaged",
  "lost",
  "in_repair",
  "retired",
  "in_studio_only",
];
const editableStatusOptions = statusOptions.filter((option) => option !== "checked_out");
const editingId = ref<string | null>(null);
const editName = ref("");
const editBarcode = ref("");
const editStatus = ref(statusOptions[0] ?? "available");
const editNotes = ref("");
let toastTimer: number | null = null;

const filteredGear = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  const status = statusFilter.value;
  return gear.value.filter((item) => {
    if (status !== "all" && item.status !== status) {
      return false;
    }
    if (!query) {
      return true;
    }
    const haystack = [
      item.name,
      item.barcode,
      item.serial_number ?? "",
      item.status,
      item.notes ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });
});

const showToast = (title: string, message: string) => {
  toastTitle.value = title;
  toastMessage.value = message;
  if (toastTimer) {
    window.clearTimeout(toastTimer);
  }
  toastTimer = window.setTimeout(() => {
    toastTitle.value = "";
    toastMessage.value = "";
    toastTimer = null;
  }, 4000);
};

const showDuplicateBarcodeToast = () => {
  showToast(
    "Unable to add item.",
    "Check barcode and make sure it does not match another item's barcode. If you belive this is an error, please contact support."
  );
};

const showInputLimitToast = () => {
  showToast(
    "Input limit reached.",
    "One or more fields are too long. Shorten the field that is too long and try again."
  );
};

const loadArchivedGear = async () => {
  isLoadingArchived.value = true;
  try {
    archivedGear.value = await fetchDeletedGear();
  } catch {
    archivedGear.value = [];
  } finally {
    isLoadingArchived.value = false;
  }
};

const loadGear = async () => {
  isLoading.value = true;
  error.value = "";
  try {
    gear.value = await fetchGear();
  } catch (err) {
    error.value = err instanceof Error ? err.message : "Unable to load items. Please sign out completeley and sign back in.";
  } finally {
    isLoading.value = false;
  }
  await loadArchivedGear();
};

const exportCsv = () => {
  exportRowsToCsv(
    `gear-${new Date().toISOString().slice(0, 10)}.csv`,
    ["name", "barcode", "serial_number", "status", "notes"],
    filteredGear.value
  );
};

const exportPdf = () => {
  exportRowsToPdf(
    `gear-${new Date().toISOString().slice(0, 10)}.pdf`,
    "Item Export",
    ["name", "barcode", "serial_number", "status", "notes"],
    filteredGear.value
  );
};

const handleCreate = async () => {
  error.value = "";
  success.value = "";
  const nameSanitized = sanitizeInput(name.value, { maxLen: 120 });
  const barcodeSanitized = sanitizeInput(barcode.value, { maxLen: 64 });
  const serialSanitized = sanitizeInput(serialNumber.value, { maxLen: 64 });
  const notesSanitized = sanitizeInput(notes.value, { maxLen: 500 });

  name.value = nameSanitized.value;
  barcode.value = barcodeSanitized.value;
  serialNumber.value = serialSanitized.value;
  notes.value = notesSanitized.value;

  const inputError =
    nameSanitized.error ||
    barcodeSanitized.error ||
    serialSanitized.error ||
    notesSanitized.error;

  if (inputError) {
    error.value = inputError;
    showInputLimitToast();
    return;
  }
  if (!name.value.trim() || !barcode.value.trim()) {
    error.value = "Name and barcode fields cannot be blank.";
    return;
  }
  const normalizedBarcode = barcode.value.trim().toLowerCase();
  const isDuplicateBarcode = gear.value.some(
    (item) => item.barcode.trim().toLowerCase() === normalizedBarcode
  );
  if (isDuplicateBarcode) {
    showDuplicateBarcodeToast();
    return;
  }

  const auth = getAuthState();
  if (!auth.tenantContextId) {
    error.value = "Missing tenant context. Please sign out completeley and sign back in.";
    return;
  }

  isSaving.value = true;
  try {
    await enforceAdminRateLimit();
    const created = await createGear({
      tenant_id: auth.tenantContextId,
      name: name.value.trim(),
      barcode: barcode.value.trim(),
      serial_number: serialNumber.value.trim(),
      status: "available",
      notes: notes.value.trim(),
    });
    await logAdminAction({
      action_type: "gear_create",
      entity_type: "gear",
      entity_id: created.id,
      metadata: { name: created.name, barcode: created.barcode },
    });
    gear.value = [created, ...gear.value];
    name.value = "";
    barcode.value = "";
    serialNumber.value = "";
    notes.value = "";
    success.value = "Item added.";
  } catch (err) {
    error.value = err instanceof Error ? err.message : "Unable to create item.";
    const message = err instanceof Error ? err.message.toLowerCase() : "";
    if (message.includes("duplicate") || message.includes("already")) {
      showDuplicateBarcodeToast();
    } else if (message.includes("invalid request") || message.includes("characters or less")) {
      showInputLimitToast();
    }
  } finally {
    isSaving.value = false;
  }
};

const startEdit = (item: GearItem) => {
  editingId.value = item.id;
  editName.value = item.name;
  editBarcode.value = item.barcode;
  editStatus.value = item.status;
  editNotes.value = item.notes ?? "";
};

const cancelEdit = () => {
  editingId.value = null;
  editName.value = "";
  editBarcode.value = "";
  editStatus.value = statusOptions[0] ?? "available";
  editNotes.value = "";
};

const saveEdit = async (id: string) => {
  error.value = "";
  success.value = "";
  const nameSanitized = sanitizeInput(editName.value, { maxLen: 120 });
  const barcodeSanitized = sanitizeInput(editBarcode.value, { maxLen: 64 });
  const notesSanitized = sanitizeInput(editNotes.value, { maxLen: 500 });

  editName.value = nameSanitized.value;
  editBarcode.value = barcodeSanitized.value;
  editNotes.value = notesSanitized.value;

  const inputError = nameSanitized.error || barcodeSanitized.error || notesSanitized.error;

  if (inputError) {
    error.value = inputError;
    showInputLimitToast();
    return;
  }
  if (!editName.value.trim() || !editBarcode.value.trim()) {
    error.value = "Name and barcode fields cannot be blank.";
    return;
  }
  isSaving.value = true;
  try {
    await enforceAdminRateLimit();
    const updated = await updateGear({
      id,
      name: editName.value.trim(),
      barcode: editBarcode.value.trim(),
      status: editStatus.value,
      notes: editNotes.value.trim(),
    });
    await logAdminAction({
      action_type: "gear_update",
      entity_type: "gear",
      entity_id: updated.id,
      metadata: { name: updated.name, barcode: updated.barcode },
    });
    gear.value = gear.value.map((item) => (item.id === id ? updated : item));
    success.value = "Item updated.";
    cancelEdit();
  } catch (err) {
    error.value = err instanceof Error ? err.message : "Unable to update item.";
    const message = err instanceof Error ? err.message.toLowerCase() : "";
    if (message.includes("invalid request") || message.includes("characters or less")) {
      showInputLimitToast();
    }
  } finally {
    isSaving.value = false;
  }
};

const removeGear = async (item: GearItem) => {
  const confirmed = window.confirm(`Archive item "${item.name}"? You can restore it later.`);
  if (!confirmed) return;
  error.value = "";
  success.value = "";
  isSaving.value = true;
  try {
    await enforceAdminRateLimit();
    await deleteGear(item.id);
    await logAdminAction({
      action_type: "gear_archive",
      entity_type: "gear",
      entity_id: item.id,
      metadata: { name: item.name, barcode: item.barcode },
    });
    gear.value = gear.value.filter((row) => row.id !== item.id);
    archivedGear.value = [item, ...archivedGear.value];
    success.value = "Item archived.";
  } catch (err) {
    error.value = err instanceof Error ? err.message : "Unable to archive item. Please try again.";
  } finally {
    isSaving.value = false;
  }
};

const handleRestore = async (item: GearItem) => {
  error.value = "";
  success.value = "";
  isSaving.value = true;
  try {
    await enforceAdminRateLimit();
    const restored = await restoreGear(item.id);
    await logAdminAction({
      action_type: "gear_restore",
      entity_type: "gear",
      entity_id: item.id,
      metadata: { name: item.name, barcode: item.barcode },
    });
    archivedGear.value = archivedGear.value.filter((row) => row.id !== item.id);
    gear.value = [restored, ...gear.value];
    success.value = "Item restored.";
  } catch (err) {
    error.value = err instanceof Error ? err.message : "Unable to restore item.";
  } finally {
    isSaving.value = false;
  }
};

onMounted(() => {
  void loadGear();
});

onUnmounted(() => {
  if (toastTimer) {
    window.clearTimeout(toastTimer);
    toastTimer = null;
  }
});
</script>
