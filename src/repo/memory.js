import { randomUUID } from 'node:crypto';
import { DomainError } from '../domain/errors.js';

// টেস্ট ও লোকাল ডেমোর জন্য ইন-মেমরি রিপোজিটরি। pg.js এর সঙ্গে একই ইন্টারফেস।
export function createMemoryRepo() {
  const stores = new Map();
  const users = new Map();

  const publicUser = (u) => u && { id: u.id, storeId: u.storeId, name: u.name, phone: u.phone, role: u.role, active: u.active };

  return {
    async registerStore({ storeName, storeKind, ownerName, phone, passwordHash }) {
      if ([...users.values()].some((u) => u.phone === phone)) {
        throw new DomainError('phone_taken', 'এই নম্বরে আগেই অ্যাকাউন্ট আছে');
      }
      const storeId = randomUUID();
      const userId = randomUUID();
      stores.set(storeId, { id: storeId, name: storeName, kind: storeKind });
      users.set(userId, { id: userId, storeId, name: ownerName, phone, passwordHash, role: 'owner', active: true });
      return { storeId, userId };
    },

    // লগইনের জন্য: পাসওয়ার্ড হ্যাশসহ ফেরত দেয়
    async findUserByPhone(phone) {
      const u = [...users.values()].find((x) => x.phone === phone);
      return u ? { ...publicUser(u), passwordHash: u.passwordHash } : null;
    },

    async getUser(storeId, userId) {
      const u = users.get(userId);
      return u && u.storeId === storeId ? publicUser(u) : null;
    },

    async getStore(storeId) {
      return stores.get(storeId) ?? null;
    },

    async createStaff(storeId, { name, phone, passwordHash }) {
      if ([...users.values()].some((u) => u.phone === phone)) {
        throw new DomainError('phone_taken', 'এই নম্বরে আগেই অ্যাকাউন্ট আছে');
      }
      const id = randomUUID();
      const u = { id, storeId, name, phone, passwordHash, role: 'staff', active: true };
      users.set(id, u);
      return publicUser(u);
    },

    async listStaff(storeId) {
      return [...users.values()].filter((u) => u.storeId === storeId).map(publicUser);
    },

    async setUserActive(storeId, userId, active) {
      const u = users.get(userId);
      if (!u || u.storeId !== storeId) return null;
      u.active = active;
      return publicUser(u);
    },
  };
}
