/**
 * 套用前的兼容性检查（T4.6）。
 *
 * 这一步不能省。Node-RED 遇到未知类型的节点**不报错**，它把节点原样留着并在
 * 编辑器里标红，等你去装对应的模块。从 API 角度看部署是成功的（返回 204），
 * 从现场角度看是「模板套了、流程在、就是不出数」—— 这种问题最费时间。
 */

export interface CompatResult {
  /** 是否齐全。**必须连着 `checked` 一起看** —— 没查成时它也是 true */
  ok: boolean;
  /**
   * 这次到底查没查成。
   *
   * 取不到目标实例的节点清单时不阻断部署（拿不到不等于不兼容），
   * 但那时的 `ok: true` 是**默认值不是结论**。少了这个字段，
   * 界面只能把「没查成」显示成绿色的「节点齐全」——
   * 那是在替一件没做过的事打包票，跟升级检查失败时不许显示「已是最新」
   * 是同一条规矩。
   */
  checked: boolean;
  missing: string[];
}

export function checkCompatibility(
  templateTypes: readonly string[],
  installedTypes: readonly string[],
): CompatResult {
  const installed = new Set(installedTypes);
  /*
   * `tab` 与 `subflow` 是 Node-RED 的结构类型，不由节点模块提供，
   * 因此不会出现在 /nodes 的类型清单里。拿它们去比对必然「缺失」，
   * 那是假警报 —— 一旦出现，用户会以为每个模板都不兼容，从此不再看这个提示。
   * `subflow:xxx` 形态的实例节点同理。
   */
  const missing = templateTypes.filter(
    (t) => t !== 'tab' && t !== 'subflow' && !t.startsWith('subflow:') && !installed.has(t),
  );
  return { ok: missing.length === 0, checked: true, missing };
}
