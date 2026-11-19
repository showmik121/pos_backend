import type { NewProduct, Product, ProductBarcode, ProductPatch } from "../domain/product.js"

// পণ্য-ক্যাটালগের রিপোজিটরি অংশ। pg-catalog.ts (আসল) ও memory-catalog.ts (টেস্ট) একই আচরণ দেয়।
export interface ProductListQuery {
  q?: string
  category?: string
  /** সঠিক মিল */
  barcode?: string
  lowStock?: boolean
  limit: number
  /** (name, id) এর পরের পাতা */
  after?: { name: string; id: string }
}

export interface CatalogRepo {
  /** নতুন হলে created=true; একই id ও একই ক্ষেত্র আগে থাকলে created=false (ইডেমপোটেন্ট); ভিন্ন হলে id_conflict */
  createProduct(storeId: string, input: NewProduct): Promise<{ product: Product; created: boolean }>
  getProduct(storeId: string, id: string): Promise<Product | null>
  /** নাম, তারপর id ক্রমে; limit+১টি পড়ে hasMore বোঝে */
  listProducts(storeId: string, query: ProductListQuery): Promise<{ items: Product[]; hasMore: boolean }>
  /** না পেলে null; expectedUpdatedAt না মিললে stale; অন্য পণ্যের বারকোড হলে duplicate_barcode */
  updateProduct(storeId: string, id: string, patch: ProductPatch): Promise<Product | null>
  /** একই কোড একই পণ্যে একই packSize-এ আগে থাকলে created=false; না পেলে null */
  addBarcode(storeId: string, productId: string, barcode: ProductBarcode): Promise<{ product: Product; created: boolean } | null>
}
