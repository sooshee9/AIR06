// StockModule — Production Version
// Logic  : Doc2 (correct formulas — vendorIssuedQty deducted ONLY in closingStock, not in purStoreOkQty)
// Design : Doc3 style (clean, debug-free, user-friendly)
//
// FORMULA:
//   purStoreOkQty = PSIR_OK − inHouseIssued(Purchase)      ← NO vendorIssued here
//   vendorOkQty   = vendorDeptOkQty − inHouseIssued(Vendor)
//   vendorIssuedQty(net) = vendorIssuedTotal − vsirReceived
//   closingStock  = stockQty + purStoreOkQty + vendorOkQty
//                   − inHouseIssued(Stock only) − vendorIssuedQty(net)

import React, { useState, useEffect } from "react";
import bus from '../utils/eventBus';
import { onAuthStateChanged } from 'firebase/auth';
import { auth, db } from '../firebase';
import { collection, onSnapshot } from 'firebase/firestore';
import {
  subscribeStockRecords, addStockRecord, updateStockRecord, deleteStockRecord,
  subscribePurchaseOrders, subscribeVendorIssues, subscribeVendorDepts,
  subscribeVSIRRecords, getItemMaster,
} from '../utils/firestoreServices';
import { subscribePsirs } from '../utils/psirService';

interface StockRecord {
  id: number;
  itemName: string;
  itemCode: string;
  batchNo: string;
  stockQty: number;
  indentQty: number;
  purchaseQty: number;
  vendorQty: number;
  purStoreOkQty: number;
  vendorOkQty: number;
  inHouseIssuedQty: number;
  vendorIssuedQty: number;
  closingStock: number;
}

// ...existing code...

const defaultItemInput: Omit<StockRecord, "id"> = {
  itemName: "", itemCode: "", batchNo: "",
  stockQty: 0, indentQty: 0, purchaseQty: 0, vendorQty: 0,
  purStoreOkQty: 0, vendorOkQty: 0, inHouseIssuedQty: 0,
  vendorIssuedQty: 0, closingStock: 0,
};

const StockModule: React.FC = () => {
  const [itemInput, setItemInput]               = useState<Omit<StockRecord, "id">>(defaultItemInput);
  const [records, setRecords]                   = useState<StockRecord[]>([]);
  const [userUid, setUserUid]                   = useState<string | null>(null);
  const [editIdx, setEditIdx]                   = useState<number | null>(null);
  const [saving, setSaving]                     = useState(false);

  const [psirsState, setPsirsState]             = useState<any[]>([]);
  const [vendorIssuesState, setVendorIssuesState]   = useState<any[]>([]);
  const [inHouseIssuesState, setInHouseIssuesState] = useState<any[]>([]);
  const [vendorDeptState, setVendorDeptState]       = useState<any[]>([]);
  const [purchaseOrdersState, setPurchaseOrdersState] = useState<any[]>([]);
  const [indentState, setIndentState]           = useState<any[]>([]);
  const [vsirRecordsState, setVsirRecordsState] = useState<any[]>([]);
  const [itemMasterState, setItemMasterState]   = useState<any[]>([]);
  const [draftPsirItems, setDraftPsirItems]     = useState<any[]>([]);

  // ─── Normalization ────────────────────────────────────────────────────────
  const normalize = (s: any) =>
    s === undefined || s === null ? '' : String(s).trim().toLowerCase();

  // ─── Raw vendor issued total ──────────────────────────────────────────────
  const getVendorIssuedQtyTotal = (itemCode: string) => {
    try {
      return (vendorIssuesState || []).reduce((total: number, issue: any) => {
        if (!Array.isArray(issue.items)) return total;
        return total + issue.items.reduce(
          (sum: number, item: any) =>
            item.itemCode === itemCode && typeof item.qty === 'number' ? sum + item.qty : sum, 0);
      }, 0);
    } catch { return 0; }
  };

  // ─── In-house issued by transaction type ─────────────────────────────────
  const getInHouseIssuedQtyByTransactionType = (itemCode: string, transactionType: string) => {
    try {
      return (inHouseIssuesState || []).reduce((total: number, issue: any) => {
        if (!Array.isArray(issue.items)) return total;
        return total + issue.items.reduce((sum: number, item: any) => {
          const matches =
            item.itemCode === itemCode &&
            (item.transactionType === transactionType || transactionType === '*');
          const qty = item.issueQty || item.qty || 0;
          return matches && typeof qty === 'number' ? sum + qty : sum;
        }, 0);
      }, 0);
    } catch { return 0; }
  };

  // ─── In-house issued (all types) by item name/code ───────────────────────
  const getInHouseIssuedQtyByItemName = (itemName: string, itemCode?: string) => {
    try {
      const targetName = normalize(itemName);
      const targetCode = normalize(itemCode);
      return (inHouseIssuesState || []).reduce((total: number, issue: any) => {
        if (!Array.isArray(issue.items)) return total;
        return total + issue.items.reduce((sum: number, item: any) => {
          const name    = normalize(item.itemName || '');
          const code    = normalize(item.itemCode || '');
          const matched = (targetName && name === targetName) || (targetCode && code === targetCode);
          const qty     = item.issueQty || item.qty || 0;
          return matched && typeof qty === 'number' ? sum + qty : sum;
        }, 0);
      }, 0);
    } catch { return 0; }
  };

  // ─── In-house issued — Stock transaction type only ───────────────────────
  const getInHouseIssuedQtyByItemNameStockOnly = (itemName: string, itemCode?: string) => {
    try {
      const targetName = normalize(itemName);
      const targetCode = normalize(itemCode);
      return (inHouseIssuesState || []).reduce((total: number, issue: any) => {
        if (!Array.isArray(issue.items)) return total;
        return total + issue.items.reduce((sum: number, item: any) => {
          const name        = normalize(item.itemName || '');
          const code        = normalize(item.itemCode || '');
          const matched     = (targetName && name === targetName) || (targetCode && code === targetCode);
          const isStockType = item.transactionType === 'Stock';
          const qty         = item.issueQty || item.qty || 0;
          return matched && isStockType && typeof qty === 'number' ? sum + qty : sum;
        }, 0);
      }, 0);
    } catch { return 0; }
  };

  // ─── Vendor dept qty total ────────────────────────────────────────────────
  const getVendorDeptQtyTotal = (itemCode: string) => {
    try {
      return (vendorDeptState || []).reduce((total: number, order: any) => {
        if (!Array.isArray(order.items)) return total;
        return total + order.items.reduce(
          (sum: number, item: any) =>
            item.itemCode === itemCode && typeof item.qty === 'number' ? sum + item.qty : sum, 0);
      }, 0);
    } catch { return 0; }
  };

  // ─── VSIR received qty total ──────────────────────────────────────────────
  const getVSIRReceivedQtyTotal = (itemCode: string) => {
    try {
      return (vsirRecordsState || []).reduce((total: number, record: any) => {
        if (record.itemCode !== itemCode) return total;
        return total +
          (typeof record.okQty     === 'number' ? record.okQty     : 0) +
          (typeof record.reworkQty === 'number' ? record.reworkQty : 0) +
          (typeof record.rejectQty === 'number' ? record.rejectQty : 0);
      }, 0);
    } catch { return 0; }
  };

  // ─── Net vendor issued (sent − returned via VSIR) ────────────────────────
  const getAdjustedVendorIssuedQty = (itemCode: string) =>
    Math.max(0, getVendorIssuedQtyTotal(itemCode) - getVSIRReceivedQtyTotal(itemCode));

  // ─── Vendor dept OK qty ───────────────────────────────────────────────────
  const getVendorDeptOkQtyTotal = (itemCode: string) => {
    try {
      return (vendorDeptState || []).reduce((total: number, order: any) => {
        if (!Array.isArray(order.items)) return total;
        return total + order.items.reduce(
          (sum: number, item: any) =>
            item.itemCode === itemCode && typeof item.okQty === 'number' ? sum + item.okQty : sum, 0);
      }, 0);
    } catch { return 0; }
  };

  // ─── Vendor OK qty ────────────────────────────────────────────────────────
  const getAdjustedVendorOkQty = (itemCode: string) =>
    Math.max(0, getVendorDeptOkQtyTotal(itemCode) - getInHouseIssuedQtyByTransactionType(itemCode, 'Vendor'));

  // ─── Indent qty ───────────────────────────────────────────────────────────
  const getIndentQtyTotal = (itemCode: string) => {
    try {
      return (indentState || []).reduce((total: number, indent: any) => {
        if (!Array.isArray(indent.items)) return total;
        return total + indent.items.reduce(
          (sum: number, item: any) =>
            item.itemCode === itemCode && typeof item.qty === 'number' ? sum + item.qty : sum, 0);
      }, 0);
    } catch { return 0; }
  };

  // ─── Purchase qty ─────────────────────────────────────────────────────────
  const getPurchaseQtyTotal = (itemCode: string) => {
    try {
      let items: any[] = [];
      (purchaseOrdersState || []).forEach((entry: any) => {
        if (Array.isArray(entry.items)) items = items.concat(entry.items);
        else if (entry.itemCode && typeof entry.qty === 'number') items.push(entry);
      });
      return items.reduce(
        (sum: number, item: any) =>
          item.itemCode === itemCode && typeof item.qty === 'number' ? sum + item.qty : sum, 0);
    } catch { return 0; }
  };

  // ─── PSIR OK qty total ───────────────────────────────────────────────────
  const getPSIROkQtyTotal = (itemName: string, itemCode?: string) => {
    try {
      const targetName = normalize(itemName);
      const targetCode = normalize(itemCode);
      const proc = (item: any) => {
        const name   = normalize(item.itemName || item.Item || '');
        const code   = normalize(item.itemCode || item.Code || item.CodeNo || '');
        const okRaw  = item.okQty == null ? 0 : Number(item.okQty || 0);
        const rcvRaw = item.qtyReceived == null ? 0 : Number(item.qtyReceived || 0);
        const ok     = okRaw > 0 ? okRaw : rcvRaw;
        return ((targetName && name === targetName) || (targetCode && code === targetCode)) ? ok : 0;
      };
      const fromPsirs = (psirsState || []).reduce((total: number, psir: any) =>
        total + (Array.isArray(psir.items) ? psir.items.reduce((s: number, it: any) => s + proc(it), 0) : 0), 0);
      const fromDraft = (draftPsirItems || []).reduce((s: number, it: any) => s + proc(it), 0);
      return fromPsirs + fromDraft;
    } catch { return 0; }
  };

  // ─── Pur Store OK Qty ─────────────────────────────────────────────────────
  // ★ vendorIssuedQty intentionally NOT deducted here — deducted only in closingStock
  const getPurStoreOkQty = (itemName: string, itemCode?: string, _batchNo?: string) =>
    Math.max(0,
      getPSIROkQtyTotal(itemName, itemCode) -
      getInHouseIssuedQtyByTransactionType(itemCode || '', 'Purchase')
    );

  // ─── Closing Stock — single source of truth ───────────────────────────────
  const calcClosingStock = (stockQty: number, itemName: string, itemCode: string, batchNo?: string): number =>
    (Number(stockQty) || 0)
    + getPurStoreOkQty(itemName, itemCode, batchNo)
    + getAdjustedVendorOkQty(itemCode)
    - getInHouseIssuedQtyByItemNameStockOnly(itemName, itemCode)
    - getAdjustedVendorIssuedQty(itemCode);   // ← vendor issued deducted HERE only

  // ─── Event bus: PSIR updates ─────────────────────────────────────────────
  useEffect(() => {
    const psirHandler = (ev: Event) => {
      try {
        const det = ((ev as CustomEvent).detail) || {};
        if (det.draftItem) setDraftPsirItems(prev => [...prev, det.draftItem]);
        else if (det.psirs) setDraftPsirItems([]);
      } catch {}
      setRecords(prev => [...prev]);
    };
    try { bus.addEventListener('psir.updated', psirHandler as EventListener); } catch {}
    return () => { try { bus.removeEventListener('psir.updated', psirHandler as EventListener); } catch {} };
  }, []);

  // ─── Auth state ──────────────────────────────────────────────────────────
  useEffect(() => {
    const unsubAuth = onAuthStateChanged(auth, (u) => setUserUid(u ? u.uid : null));
    return () => { try { unsubAuth(); } catch {} };
  }, []);

  // ─── Firestore subscriptions ─────────────────────────────────────────────
  useEffect(() => {
    let unsub: (() => void) | null = null;
    if (userUid) {
      try {
        unsub = subscribeStockRecords(userUid, (docs: any[]) => {
          setRecords(docs.map(d => ({
            id: d.id,
            itemName: d.itemName || '', itemCode: d.itemCode || '', batchNo: d.batchNo || '',
            stockQty:         Number(d.stockQty)         || 0,
            indentQty:        Number(d.indentQty)        || 0,
            purchaseQty:      Number(d.purchaseQty)      || 0,
            vendorQty:        Number(d.vendorQty)        || 0,
            purStoreOkQty:    Number(d.purStoreOkQty)    || 0,
            vendorOkQty:      Number(d.vendorOkQty)      || 0,
            inHouseIssuedQty: Number(d.inHouseIssuedQty) || 0,
            vendorIssuedQty:  Number(d.vendorIssuedQty)  || 0,
            closingStock:     Number(d.closingStock)     || 0,
          } as StockRecord)));
        });
      } catch (err) { console.error('[StockModule] subscribeStockRecords error:', err); }
    } else {
      setRecords([]);
    }

    let unsubPsir: (() => void) | null = null;
    let unsubVendorIssues: (() => void) | null = null;
    let unsubVendorDepts: (() => void) | null = null;
    let unsubPurchaseOrders: (() => void) | null = null;
    let unsubVSIR: (() => void) | null = null;
    let unsubInHouse: (() => void) | null = null;
    let unsubIndent: (() => void) | null = null;

    if (userUid) {
      try { unsubPsir           = subscribePsirs(userUid,          docs => setPsirsState(docs)); } catch {}
      try { unsubVendorIssues   = subscribeVendorIssues(userUid,   docs => setVendorIssuesState(docs)); } catch {}
      try { unsubVendorDepts    = subscribeVendorDepts(userUid,    docs => setVendorDeptState(docs)); } catch {}
      try { unsubPurchaseOrders = subscribePurchaseOrders(userUid, docs => setPurchaseOrdersState(docs)); } catch {}
      try { unsubVSIR           = subscribeVSIRRecords(userUid,    docs => setVsirRecordsState(docs)); } catch {}
      try {
        const coll = collection(db, 'users', userUid, 'inHouseIssues');
        unsubInHouse = onSnapshot(coll, snap =>
          setInHouseIssuesState(snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }))));
      } catch {}
      try {
        const coll2 = collection(db, 'users', userUid, 'indentData');
        unsubIndent = onSnapshot(coll2, snap =>
          setIndentState(snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }))));
      } catch {}
      (async () => {
        try {
          const items = await getItemMaster(userUid);
          setItemMasterState((items || []) as any[]);
        } catch { setItemMasterState([]); }
      })();
    } else {
      setPsirsState([]); setVendorIssuesState([]); setInHouseIssuesState([]);
      setVendorDeptState([]); setPurchaseOrdersState([]); setIndentState([]);
      setVsirRecordsState([]); setItemMasterState([]);
    }

    return () => {
      try { if (unsub)              unsub();               } catch {}
      try { if (unsubPsir)          unsubPsir();           } catch {}
      try { if (unsubVendorIssues)  unsubVendorIssues();   } catch {}
      try { if (unsubVendorDepts)   unsubVendorDepts();    } catch {}
      try { if (unsubPurchaseOrders)unsubPurchaseOrders(); } catch {}
      try { if (unsubVSIR)          unsubVSIR();           } catch {}
      try { if (unsubInHouse)       unsubInHouse();        } catch {}
      try { if (unsubIndent)        unsubIndent();         } catch {}
    };
  }, [userUid]);

  // ─── Broadcast to other modules ──────────────────────────────────────────
  useEffect(() => {
    try { bus.dispatchEvent(new CustomEvent('stock.updated', { detail: { records } })); } catch {}
  }, [records]);

  // ─── Form handlers ────────────────────────────────────────────────────────
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target;
    if (name === "itemName") {
      const found = itemMasterState.find((item) => item.itemCode === value);
      setItemInput(prev => ({
        ...prev,
        itemName: found ? found.itemName : "",
        itemCode: found ? found.itemCode : "",
      }));
    } else {
      setItemInput(prev => ({ ...prev, [name]: type === "number" ? Number(value) : value }));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!itemInput.itemName) { alert("Item Name is required."); return; }
    setSaving(true);

    const vendorIssuedTotal       = getVendorIssuedQtyTotal(itemInput.itemCode);
    const vendorDeptTotal         = getVendorDeptQtyTotal(itemInput.itemCode);
    const vendorIssuedQtyAdjusted = getAdjustedVendorIssuedQty(itemInput.itemCode);

    const autoRecord = {
      ...itemInput,
      indentQty:        getIndentQtyTotal(itemInput.itemCode),
      purchaseQty:      getPurchaseQtyTotal(itemInput.itemCode),
      vendorQty:        Math.max(0, vendorDeptTotal - vendorIssuedTotal),
      purStoreOkQty:    getPurStoreOkQty(itemInput.itemName, itemInput.itemCode, itemInput.batchNo),
      vendorOkQty:      getAdjustedVendorOkQty(itemInput.itemCode),
      inHouseIssuedQty: getInHouseIssuedQtyByItemName(itemInput.itemName, itemInput.itemCode),
      vendorIssuedQty:  vendorIssuedQtyAdjusted,
      closingStock:     calcClosingStock(itemInput.stockQty, itemInput.itemName, itemInput.itemCode, itemInput.batchNo),
    };

    try {
      if (editIdx !== null) {
        const existing = records[editIdx];
        if (userUid && existing && typeof (existing as any).id === 'string') {
          await updateStockRecord(userUid, String((existing as any).id), autoRecord);
          setRecords(prev => prev.map((rec, idx) => idx === editIdx ? { ...autoRecord, id: rec.id } : rec));
        } else {
          setRecords(prev => prev.map((rec, idx) => idx === editIdx ? { ...autoRecord, id: rec.id } : rec));
        }
        setEditIdx(null);
      } else {
        if (userUid) {
          const newId = await addStockRecord(userUid, autoRecord);
          setRecords(prev => [...prev, { ...autoRecord, id: newId } as any]);
        } else {
          setRecords(prev => [...prev, { ...autoRecord, id: Date.now() }]);
        }
      }
    } catch (err) {
      console.error('[StockModule] save failed:', err);
      alert('Failed to save record. Please try again.');
    } finally {
      setSaving(false);
    }
    setItemInput(defaultItemInput);
  };

  const handleEdit = (idx: number) => {
    setItemInput(records[idx]);
    setEditIdx(idx);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleDelete = async (idx: number) => {
    if (!window.confirm('Delete this stock record?')) return;
    const rec = records[idx];
    if (userUid && rec && typeof (rec as any).id === 'string') {
      try {
        await deleteStockRecord(userUid, String((rec as any).id));
      } catch (err) {
        console.error('[StockModule] delete failed:', err);
        alert('Failed to delete record. Please try again.');
      }
    } else {
      setRecords(prev => prev.filter((_, i) => i !== idx));
    }
  };

  const isEditing = editIdx !== null;
  const hasItem   = !!(itemInput.itemName || itemInput.itemCode);

  // Live computed values for form preview
  const liveIndentQty     = getIndentQtyTotal(itemInput.itemCode);
  const livePurchaseQty   = getPurchaseQtyTotal(itemInput.itemCode);
  const liveVendorIssuedT = getVendorIssuedQtyTotal(itemInput.itemCode);
  const liveVendorDeptT   = getVendorDeptQtyTotal(itemInput.itemCode);
  const liveVendorQty     = Math.max(0, liveVendorDeptT - liveVendorIssuedT);
  const livePurStoreOkQty = getPurStoreOkQty(itemInput.itemName, itemInput.itemCode, itemInput.batchNo);
  const liveVendorOkQty   = getAdjustedVendorOkQty(itemInput.itemCode);
  const liveInHouseIssued = getInHouseIssuedQtyByItemName(itemInput.itemName, itemInput.itemCode);
  const liveVendorIssued  = getAdjustedVendorIssuedQty(itemInput.itemCode);
  const liveClosingStock  = calcClosingStock(itemInput.stockQty, itemInput.itemName, itemInput.itemCode, itemInput.batchNo);

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div style={{ fontFamily: "'Segoe UI', system-ui, sans-serif", color: "#1d2939", padding: "24px", maxWidth: 1400, margin: "0 auto" }}>

      {/* ── Header ── */}
      <div style={{ marginBottom: 24, paddingBottom: 16, borderBottom: "2px solid #e4e7ec" }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "#101828" }}>📦 Stock Module</h2>
        <p style={{ margin: "4px 0 0", fontSize: 14, color: "#667085" }}>
          All quantities are auto-computed from live data
        </p>
      </div>

      {/* ── Form Card ── */}
      <div style={{ background: "#fff", border: "1px solid #e4e7ec", borderRadius: 10, padding: 24, marginBottom: 28, boxShadow: "0 1px 4px rgba(0,0,0,0.06)" }}>
        <h3 style={{ margin: "0 0 18px", fontSize: 15, fontWeight: 600, color: "#344054" }}>
          {isEditing ? "✏️ Edit Stock Record" : "➕ New Stock Record"}
        </h3>

        <form onSubmit={handleSubmit}>
          {/* User inputs row */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginBottom: 16 }}>

            {/* Item Name */}
            <div style={{ flex: "2 1 240px", minWidth: 200 }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#344054", marginBottom: 5, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                Item Name *
              </label>
              <select
                name="itemName"
                value={itemInput.itemCode}
                onChange={handleChange}
                style={{
                  width: "100%", padding: "8px 10px", borderRadius: 6, fontSize: 14,
                  fontFamily: "inherit", boxSizing: "border-box", background: "#fff",
                  border: itemMasterState.length === 0 ? "1.5px solid #f79009" : "1px solid #d0d5dd",
                }}
              >
                <option value="">
                  {itemMasterState.length === 0 ? "⚠ No items in Item Master" : "— Select an item —"}
                </option>
                {itemMasterState.map(item => (
                  <option key={item.id || item.itemCode} value={item.itemCode}>
                    {item.itemName} - {item.itemCode}
                  </option>
                ))}
              </select>
            </div>

            {/* Item Code */}
            <div style={{ flex: "1 1 130px", minWidth: 120 }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#344054", marginBottom: 5, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                Item Code
              </label>
              <input
                readOnly value={itemInput.itemCode} placeholder="Auto-filled"
                style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid #d0d5dd", fontSize: 14, fontFamily: "inherit", background: "#f2f4f7", color: "#667085", boxSizing: "border-box" }}
              />
            </div>

            {/* Batch No */}
            <div style={{ flex: "1 1 130px", minWidth: 120 }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#344054", marginBottom: 5, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                Batch No
              </label>
              <input
                name="batchNo" value={itemInput.batchNo} onChange={handleChange} placeholder="Optional"
                style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid #d0d5dd", fontSize: 14, fontFamily: "inherit", background: "#fff", boxSizing: "border-box" }}
              />
            </div>

            {/* Stock Qty */}
            <div style={{ flex: "1 1 130px", minWidth: 120 }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#344054", marginBottom: 5, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                Opening Stock Qty
              </label>
              <input
                type="number" name="stockQty" value={itemInput.stockQty || ""} onChange={handleChange} min={0} placeholder="0"
                style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid #d0d5dd", fontSize: 14, fontFamily: "inherit", background: "#fff", boxSizing: "border-box" }}
              />
            </div>
          </div>

          {/* Auto-computed preview — shown when item is selected */}
          {hasItem && (
            <div style={{ background: "#f8f9fc", border: "1px solid #e4e7ec", borderRadius: 8, padding: "14px 18px", marginBottom: 18 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#667085", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 12 }}>
                Auto-computed values (live)
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 20 }}>
                {[
                  { label: "Indent Qty",         value: liveIndentQty },
                  { label: "Purchase Qty",        value: livePurchaseQty },
                  { label: "Vendor Qty",          value: liveVendorQty },
                  { label: "Pur Store OK",        value: livePurStoreOkQty,  blue: true },
                  { label: "Vendor OK",           value: liveVendorOkQty,    blue: true },
                  { label: "In-House Issued",     value: liveInHouseIssued },
                  { label: "Vendor Issued (net)", value: liveVendorIssued,   orange: true },
                ].map(f => (
                  <div key={f.label}>
                    <div style={{ fontSize: 11, color: "#667085", marginBottom: 2 }}>{f.label}</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: f.blue ? "#3538cd" : f.orange ? "#b54708" : "#344054" }}>
                      {f.value}
                    </div>
                  </div>
                ))}

                {/* Closing Stock — highlighted */}
                <div style={{
                  padding: "6px 16px", borderRadius: 8, minWidth: 110,
                  background: liveClosingStock < 0 ? "#fff1f0" : "#ecfdf3",
                  border: `1.5px solid ${liveClosingStock < 0 ? "#fca5a5" : "#6ee7b7"}`,
                }}>
                  <div style={{ fontSize: 11, color: "#667085", marginBottom: 2 }}>Closing Stock</div>
                  <div style={{ fontSize: 24, fontWeight: 800, color: liveClosingStock < 0 ? "#dc2626" : "#059669" }}>
                    {liveClosingStock}
                  </div>
                </div>
              </div>

              <div style={{ marginTop: 10, fontSize: 11, color: "#98a2b3", borderTop: "1px solid #e4e7ec", paddingTop: 8 }}>
                Formula: Opening Stock + Pur Store OK + Vendor OK − In-House Issued (Stock) − Vendor Issued (net)
              </div>
            </div>
          )}

          {/* Buttons */}
          <div style={{ display: "flex", gap: 10 }}>
            <button
              type="submit" disabled={saving}
              style={{ padding: "9px 22px", background: saving ? "#93c5fd" : "#1d4ed8", color: "#fff", border: "none", borderRadius: 7, fontWeight: 600, fontSize: 14, cursor: saving ? "not-allowed" : "pointer", fontFamily: "inherit" }}
            >
              {saving ? "Saving…" : isEditing ? "✓ Update Record" : "✓ Add Record"}
            </button>
            <button
              type="button"
              onClick={() => { setItemInput(defaultItemInput); setEditIdx(null); }}
              style={{ padding: "9px 18px", background: "transparent", color: "#667085", border: "1px solid #d0d5dd", borderRadius: 7, fontWeight: 500, fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}
            >
              {isEditing ? "Cancel" : "Clear"}
            </button>
          </div>
        </form>
      </div>

      {/* ── Records Table ── */}
      <div style={{ background: "#fff", border: "1px solid #e4e7ec", borderRadius: 10, boxShadow: "0 1px 4px rgba(0,0,0,0.06)", overflow: "hidden" }}>

        <div style={{ padding: "14px 20px", borderBottom: "1px solid #e4e7ec", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: "#344054" }}>Stock Records</h3>
          <span style={{ fontSize: 13, color: "#667085", background: "#f2f4f7", padding: "3px 10px", borderRadius: 20, border: "1px solid #e4e7ec" }}>
            {records.length} {records.length === 1 ? "item" : "items"}
          </span>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {["#", "Item Name", "Item Code", "Batch No", "Opening Stock", "Indent Qty", "Purchase Qty", "Vendor Qty", "Pur Store OK", "Vendor OK", "In-House Issued", "Vendor Issued", "Closing Stock", "Actions"].map((h, i) => (
                  <th key={i} style={{
                    border: "1px solid #e4e7ec", padding: "10px 12px",
                    background: "#f8f9fc", fontWeight: 700, fontSize: 12,
                    color: h === "Pur Store OK" || h === "Vendor OK" ? "#3538cd"
                         : h === "Closing Stock" ? "#027a48"
                         : h === "Vendor Issued" ? "#b54708"
                         : "#344054",
                    textAlign: i > 3 ? "right" : "left",
                    textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap",
                  }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {records.length === 0 ? (
                <tr>
                  <td colSpan={14} style={{ textAlign: "center", padding: "36px 0", color: "#98a2b3", fontSize: 14, border: "1px solid #e4e7ec" }}>
                    No stock records yet. Add your first item above.
                  </td>
                </tr>
              ) : records.map((rec, idx) => {
                const closing = calcClosingStock(rec.stockQty, rec.itemName, rec.itemCode, rec.batchNo);
                return (
                  <tr key={rec.id} style={{ background: idx % 2 === 0 ? "#fff" : "#f9fafb" }}>
                    <td style={{ border: "1px solid #e4e7ec", padding: "9px 12px", fontSize: 12, color: "#98a2b3", textAlign: "center" }}>{idx + 1}</td>
                    <td style={{ border: "1px solid #e4e7ec", padding: "9px 12px", fontSize: 14, fontWeight: 500 }}>{rec.itemName}</td>
                    <td style={{ border: "1px solid #e4e7ec", padding: "9px 12px", fontSize: 13, fontFamily: "monospace" }}>{rec.itemCode}</td>
                    <td style={{ border: "1px solid #e4e7ec", padding: "9px 12px", fontSize: 14, color: "#667085" }}>{rec.batchNo || "—"}</td>
                    <td style={{ border: "1px solid #e4e7ec", padding: "9px 12px", fontSize: 14, textAlign: "right", fontWeight: 600 }}>{rec.stockQty}</td>
                    <td style={{ border: "1px solid #e4e7ec", padding: "9px 12px", fontSize: 14, textAlign: "right" }}>{getIndentQtyTotal(rec.itemCode)}</td>
                    <td style={{ border: "1px solid #e4e7ec", padding: "9px 12px", fontSize: 14, textAlign: "right" }}>{getPurchaseQtyTotal(rec.itemCode)}</td>
                    <td style={{ border: "1px solid #e4e7ec", padding: "9px 12px", fontSize: 14, textAlign: "right" }}>
                      {Math.max(0, getVendorDeptQtyTotal(rec.itemCode) - getVendorIssuedQtyTotal(rec.itemCode))}
                    </td>
                    <td style={{ border: "1px solid #e4e7ec", padding: "9px 12px", fontSize: 14, textAlign: "right", color: "#3538cd", fontWeight: 600 }}>
                      {getPurStoreOkQty(rec.itemName, rec.itemCode, rec.batchNo)}
                    </td>
                    <td style={{ border: "1px solid #e4e7ec", padding: "9px 12px", fontSize: 14, textAlign: "right", color: "#3538cd", fontWeight: 600 }}>
                      {getAdjustedVendorOkQty(rec.itemCode)}
                    </td>
                    <td style={{ border: "1px solid #e4e7ec", padding: "9px 12px", fontSize: 14, textAlign: "right" }}>
                      {getInHouseIssuedQtyByItemName(rec.itemName, rec.itemCode)}
                    </td>
                    <td style={{ border: "1px solid #e4e7ec", padding: "9px 12px", fontSize: 14, textAlign: "right", color: "#b54708" }}>
                      {getAdjustedVendorIssuedQty(rec.itemCode)}
                    </td>
                    <td style={{ border: "1px solid #e4e7ec", padding: "9px 12px", fontSize: 15, textAlign: "right", fontWeight: 800, color: closing < 0 ? "#dc2626" : "#027a48" }}>
                      {closing}
                    </td>
                    <td style={{ border: "1px solid #e4e7ec", padding: "9px 12px", textAlign: "center" }}>
                      <div style={{ display: "flex", gap: 6, justifyContent: "center" }}>
                        <button
                          onClick={() => handleEdit(idx)}
                          style={{ padding: "4px 12px", background: "#eff4ff", color: "#3538cd", border: "1px solid #c7d7fd", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDelete(idx)}
                          style={{ padding: "4px 12px", background: "transparent", color: "#dc2626", border: "1px solid #fecaca", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>

            {records.length > 0 && (() => {
              const grandTotal = records.reduce((s, r) => s + calcClosingStock(r.stockQty, r.itemName, r.itemCode, r.batchNo), 0);
              return (
                <tfoot>
                  <tr style={{ background: "#eff4ff" }}>
                    <td colSpan={12} style={{ border: "1px solid #e4e7ec", padding: "10px 12px", fontWeight: 700, color: "#344054", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                      Total Closing Stock ({records.length} items)
                    </td>
                    <td style={{ border: "1px solid #e4e7ec", padding: "10px 12px", textAlign: "right", fontWeight: 800, fontSize: 16, color: grandTotal < 0 ? "#dc2626" : "#027a48" }}>
                      {grandTotal}
                    </td>
                    <td style={{ border: "1px solid #e4e7ec" }} />
                  </tr>
                </tfoot>
              );
            })()}
          </table>
        </div>
      </div>
    </div>
  );
};

export default StockModule;