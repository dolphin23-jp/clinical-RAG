// Search dictionary (enhancement plan T1-9): deterministic query expansion for the lexical search.
// The index matches words, so "高K血症" does not find a section that only says "hyperkalemia" or "透析の適応".
// Each group lists spellings / names that mean the same thing (`terms`, two-way), abbreviations that are too ambiguous to
// add to a search but fine as a way in (`abbr`, trigger only: "PE" may be pleural effusion), and one-way concept words
// (`related`) for the sections that discuss the condition under another heading.
// Added without line-by-line review by the doctor (doctor's decision, 2026-10-24). No numbers, doses or thresholds here.
// Expansions only add candidates at a lower RRF weight (search.ts); they never remove a hit.

export interface TermGroup {
  terms: string[];
  abbr?: string[];
  related?: string[];
}

export const DICTIONARY: TermGroup[] = [
  // ---- electrolytes / acid-base
  { terms: ["高カリウム血症", "高K血症", "hyperkalemia"], related: ["透析", "腎代替療法", "カリウム吸着薬", "GI療法", "グルコン酸カルシウム", "心電図"] },
  { terms: ["低カリウム血症", "低K血症", "hypokalemia"], related: ["カリウム補充"] },
  { terms: ["高ナトリウム血症", "高Na血症", "hypernatremia"], related: ["自由水欠乏"] },
  { terms: ["低ナトリウム血症", "低Na血症", "hyponatremia"], related: ["SIADH", "血漿浸透圧", "浸透圧性脱髄症候群"] },
  { terms: ["高カルシウム血症", "高Ca血症", "hypercalcemia"] },
  { terms: ["低カルシウム血症", "低Ca血症", "hypocalcemia"] },
  { terms: ["高リン血症", "高P血症", "hyperphosphatemia"] },
  { terms: ["低マグネシウム血症", "低Mg血症", "hypomagnesemia"] },
  { terms: ["代謝性アシドーシス", "metabolic acidosis"], related: ["アニオンギャップ", "血液ガス", "重炭酸"] },
  { terms: ["代謝性アルカローシス", "metabolic alkalosis"] },
  { terms: ["アニオンギャップ", "anion gap"], abbr: ["AG"] },
  { terms: ["血液ガス", "動脈血ガス", "ABG", "blood gas"] },
  { terms: ["抗利尿ホルモン不適合分泌症候群", "SIADH"] },
  // ---- kidney
  { terms: ["急性腎障害", "急性腎不全", "AKI", "acute kidney injury"], related: ["腎前性", "腎後性", "KDIGO"] },
  { terms: ["慢性腎臓病", "CKD", "chronic kidney disease"] },
  { terms: ["腎代替療法", "血液浄化療法", "RRT", "renal replacement therapy"], related: ["透析"] },
  { terms: ["血液透析", "hemodialysis"], abbr: ["HD"] },
  { terms: ["持続的腎代替療法", "CRRT", "CHDF"] },
  { terms: ["腹膜透析", "peritoneal dialysis"], abbr: ["PD"] },
  { terms: ["推算糸球体濾過量", "推算GFR", "eGFR"] },
  { terms: ["クレアチニン", "Cr", "creatinine"] },
  { terms: ["尿素窒素", "BUN", "urea nitrogen"] },
  { terms: ["ネフローゼ症候群", "nephrotic syndrome"] },
  { terms: ["糸球体腎炎", "glomerulonephritis"] },
  { terms: ["急速進行性糸球体腎炎", "RPGN"] },
  { terms: ["IgA腎症", "IgA nephropathy"] },
  { terms: ["造影剤腎症", "造影剤関連急性腎障害", "CI-AKI", "contrast-induced nephropathy"] },
  { terms: ["横紋筋融解症", "横紋筋融解", "rhabdomyolysis"], related: ["CK"] },
  { terms: ["腫瘍崩壊症候群", "TLS", "tumor lysis syndrome"] },
  { terms: ["腎盂腎炎", "pyelonephritis"], related: ["尿路感染症"] },
  { terms: ["尿路感染症", "UTI", "urinary tract infection"] },
  // ---- emergency / general internal medicine
  { terms: ["敗血症", "sepsis"], related: ["SOFA", "乳酸", "血液培養"] },
  { terms: ["敗血症性ショック", "septic shock"], related: ["昇圧薬"] },
  { terms: ["アナフィラキシー", "anaphylaxis"] },
  { terms: ["意識障害", "disturbance of consciousness"], related: ["AIUEOTIPS"] },
  { terms: ["AIUEOTIPS", "AIUEO TIPS"] },
  { terms: ["低血糖", "hypoglycemia"] },
  { terms: ["糖尿病性ケトアシドーシス", "DKA", "diabetic ketoacidosis"] },
  { terms: ["高浸透圧高血糖状態", "HHS", "hyperosmolar hyperglycemic state"] },
  { terms: ["急性冠症候群", "ACS", "acute coronary syndrome"] },
  { terms: ["心筋梗塞", "myocardial infarction"], abbr: ["MI", "AMI"] },
  { terms: ["ST上昇型心筋梗塞", "STEMI"] },
  { terms: ["心不全", "heart failure"] },
  { terms: ["心房細動", "atrial fibrillation"], abbr: ["AF"] },
  { terms: ["肺塞栓症", "肺血栓塞栓症", "pulmonary embolism"], abbr: ["PE", "PTE"] },
  { terms: ["深部静脈血栓症", "DVT", "deep vein thrombosis"] },
  { terms: ["静脈血栓塞栓症", "VTE", "venous thromboembolism"] },
  { terms: ["大動脈解離", "aortic dissection"] },
  { terms: ["脳卒中", "stroke"] },
  { terms: ["脳梗塞", "cerebral infarction"] },
  { terms: ["くも膜下出血", "SAH", "subarachnoid hemorrhage"] },
  { terms: ["失神", "syncope"] },
  { terms: ["痙攣", "けいれん", "seizure"] },
  { terms: ["てんかん重積", "痙攣重積", "status epilepticus"] },
  { terms: ["消化管出血", "GI bleeding", "gastrointestinal bleeding"] },
  { terms: ["急性膵炎", "acute pancreatitis"] },
  { terms: ["慢性閉塞性肺疾患", "COPD"] },
  { terms: ["気管支喘息", "喘息", "asthma"] },
  { terms: ["肺炎", "pneumonia"] },
  { terms: ["播種性血管内凝固", "DIC", "disseminated intravascular coagulation"] },
  // ---- tests
  { terms: ["心電図", "ECG", "EKG", "electrocardiogram"] },
  { terms: ["胸部X線", "胸部レントゲン", "chest X-ray", "CXR"] },
  // ---- drugs: Japanese naming variants and classes (generic names only, no brand names)
  { terms: ["アドレナリン", "エピネフリン", "adrenaline", "epinephrine"] },
  { terms: ["ノルアドレナリン", "ノルエピネフリン", "noradrenaline", "norepinephrine"] },
  { terms: ["ブドウ糖", "グルコース", "glucose"] },
  { terms: ["炭酸水素ナトリウム", "重炭酸ナトリウム", "sodium bicarbonate"] },
  { terms: ["グルコン酸カルシウム", "calcium gluconate"] },
  { terms: ["塩化カルシウム", "calcium chloride"] },
  { terms: ["カリウム吸着薬", "陽イオン交換樹脂", "potassium binder"] },
  { terms: ["フロセミド", "furosemide"], related: ["ループ利尿薬"] },
  { terms: ["ループ利尿薬", "loop diuretic"] },
  { terms: ["非ステロイド性抗炎症薬", "NSAIDs", "NSAID"] },
  { terms: ["ACE阻害薬", "ACEI", "ACE inhibitor"] },
  { terms: ["アンジオテンシンII受容体拮抗薬", "アンジオテンシン受容体拮抗薬", "ARB"] },
  { terms: ["SGLT2阻害薬", "SGLT2 inhibitor"] },
  { terms: ["昇圧薬", "血管収縮薬", "vasopressor"] },
  // ---- clinical reasoning
  { terms: ["尤度比", "likelihood ratio"] },
  { terms: ["検査前確率", "事前確率", "pretest probability"] },
  { terms: ["感度", "sensitivity"] },
  { terms: ["特異度", "specificity"] },
];

/** Cap on terms added per search (each kind is one OR query per index, so the D1 query count stays fixed). */
export const MAX_SYNONYMS = 12;
export const MAX_RELATED = 8;

const normT = (s: string): string => s.normalize("NFKC").toLowerCase();
const isLatin = (t: string): boolean => /^[0-9a-z][0-9a-z .+\-]*$/.test(t);
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Latin terms match as whole words (so "hd" does not fire inside "hdl"); CJK / mixed terms match as substrings. */
function occurs(term: string, text: string): boolean {
  const t = normT(term);
  if (!t) return false;
  if (isLatin(t)) return new RegExp(`(^|[^0-9a-z])${escapeRe(t)}($|[^0-9a-z])`).test(text);
  return text.includes(t);
}

export interface Expansion {
  synonyms: string[];
  related: string[];
}

/** Terms to add for these queries: the other spellings of every matched group, then its related words. */
export function expandQueries(queries: string[], dict: TermGroup[] = DICTIONARY): Expansion {
  const text = queries.map(normT).join(" \n ");
  const synonyms: string[] = [];
  const related: string[] = [];
  const seen = new Set<string>();
  const push = (list: string[], t: string, cap: number) => {
    const k = normT(t);
    if (seen.has(k) || occurs(t, text) || list.length >= cap) return;
    seen.add(k);
    list.push(t);
  };
  for (const g of dict) {
    if (![...g.terms, ...(g.abbr ?? [])].some((t) => occurs(t, text))) continue;
    for (const t of g.terms) push(synonyms, t, MAX_SYNONYMS);
    for (const t of g.related ?? []) push(related, t, MAX_RELATED);
  }
  return { synonyms, related };
}
