const phonePattern = /(?:\+?86[-\s]?)?1[3-9]\d{9}/;
const idCardPattern = /\b\d{6}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/;
const hospitalNumberPattern = /(?:住院号|病案号|门诊号|就诊卡号)\s*[:：]?\s*[A-Za-z0-9-]{5,}/;
const addressPattern = /(?:省|市|区|县|镇|乡|街道|小区|单元|门牌|路|巷).{0,24}\d{1,5}(?:号|室|栋|幢)?/;

export interface PrivacyCheck {
  ok: boolean;
  findings: string[];
}

export function checkSensitiveText(values: string[]): PrivacyCheck {
  const text = values.join("\n");
  const findings: string[] = [];
  if (phonePattern.test(text)) findings.push("手机号");
  if (idCardPattern.test(text)) findings.push("身份证号");
  if (hospitalNumberPattern.test(text)) findings.push("住院号/病案号/门诊号");
  if (addressPattern.test(text)) findings.push("详细地址");
  return { ok: findings.length === 0, findings };
}

export function assertPrivacy(values: string[]): void {
  const result = checkSensitiveText(values);
  if (!result.ok) {
    const detail = result.findings.join("、");
    const error = new Error(`检测到可能的身份信息：${detail}。请删除后再提交。`);
    error.name = "PrivacyError";
    throw error;
  }
}
