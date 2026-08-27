/** 转出配置层的纯函数，供服务层使用，避免服务层直接依赖配置加载逻辑 */
export { adminRootFor, authTokenKeyFor } from './config.ts';
