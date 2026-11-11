/**
 * B2 运动与物理 —— 常量与默认参数。
 *
 * 口径（docs/wave2-integration.md §1 / §3-B2）：
 * - 坐标一律为 **overlay 窗口本地 CSS 像素**：原点 = 窗口左上角，x→右、y→下；
 *   单位为 px、时间为秒（s）、速度为 px/s、加速度为 px/s²；
 * - 重力默认 2400 px/s²（文档建议区间 2200–2600，1080p / 50% 尺寸下 ≈0.4s 从半屏高落地）；
 * - 所有常量均为「调参入口」：单测/Lead 可通过构造参数覆盖 gravity / 拖拽 τ / 坐接近速度；
 *   其余常量视为模块内部实现细节，不鼓励外部依赖。
 */

/** 默认重力加速度（px/s²；2200–2600 区间的中值）。 */
export const DEFAULT_GRAVITY_PX_PER_SEC2 = 2400

/** 单帧最大积分步长（秒）。main.ts 已把渲染 dt 钳制 ≤0.1；这里再兜底一次，防大 dt 穿透。 */
export const MAX_STEP_DT_SEC = 0.1

/** moveTo walk / climb 的到位容差（px）：距离小于它即视为到达，速度清零。 */
export const MOVE_ARRIVE_EPS_PX = 1.5

/** 朝向推导速度阈值（px/s）：水平速度低于它时保持上一朝向、改用目标点方向推导。 */
export const FACING_SPEED_EPS_PX_PER_SEC = 2

/** 地面摩擦指数衰减系数（1/s）：vx *= exp(-k·dt)。k=6 时约 0.3s 滑行到 1/6。 */
export const GROUND_FRICTION_DAMPING_PER_SEC = 6

/** 地面摩擦停止阈值（px/s）：低于它直接归零，避免无限小数尾巴。 */
export const GROUND_STOP_SPEED_PX_PER_SEC = 2

/** 撞左右墙的水平反弹系数（被甩飞时的小 bounce）。 */
export const WALL_RESTITUTION = 0.4

/** 撞墙 / 撞天花板反弹的最小速度（px/s）：低于它直接归零，避免抖动。 */
export const WALL_BOUNCE_MIN_SPEED_PX_PER_SEC = 40

/** 撞天花板（workArea 顶边）的竖直反弹系数（一般极少数情况会摸到）。 */
export const CEILING_RESTITUTION = 0.2

/** 甩出速度估计窗口（ms）：只用最近这段时间的指针样本（文档建议 100–150ms）。 */
export const THROW_SAMPLE_WINDOW_MS = 120

/** 甩出速度上限（px/s）：防止瞬间抖动造成离谱初速。 */
export const THROW_MAX_SPEED_PX_PER_SEC = 4000

/** 指针速度样本上限（个）：防御异常高频事件，保证内存/耗时 O(1)。 */
export const THROW_MAX_SAMPLES = 64

/** 拖拽指数平滑时间常数（ms）：τ 越大越"拖泥带水"，40–70ms 观感自然。 */
export const DRAG_SMOOTHING_TAU_MS = 45

/**
 * 拖拽起手时的默认侧身朝向（V7 humanoid 适配 / 用户实机反馈）。
 *
 * 背景：被拎起来（drag）时宠物应呈**侧身悬挂**的侧面剪影；此前起手若 facing='front'
 * 会保持正面朝镜头，观感像「被举着的立牌」。`beginDrag` 时若当前是正面则切到这个侧向
 * （已有侧向/正在走的方向保持不变）；拖动中的水平移动仍由速度方向继续更新朝向，
 * 落地后由行为层（PetRuntime 静止时 facing='front'）自然转回正面。
 *
 * 选 'right' 只是默认值：模型朝 +X（屏幕右）时侧面剪影与拖拽 clip 的肢体朝向一致，
 * 实机观感需 Lead 抓图确认，若反了只改这一处常量即可。
 */
export const DRAG_START_FACING = 'right' as const

/**
 * sit 接近阶段的默认移动速度（px/s；B1 的 sit 指令不带速度）。
 *
 * 2026-11-08 用户反馈坐窗沿「先慢慢滑过去很久」观感差：120px/s 走 700px 要 6s，且 B1 活动时长
 * 可能在到达前就耗尽。提到 520px/s 让接近阶段 ~1–2s（配合 walk 动画快速到位），坐下后由
 * `seatedAnchor='hips'` 对齐窗沿。
 */
export const DEFAULT_SIT_APPROACH_SPEED_PX_PER_SEC = 520

/** 隐式地面表面 id：B5 未提供 kind='screen-bottom' 表面时，B2 用 workArea 底边当地面。 */
export const IMPLICIT_GROUND_SURFACE_ID = 'screen-bottom'

/**
 * 攀爬结束时的吸附容差（px）：
 * B1 的到位判定是 16px（`ARRIVE_EPSILON_PX`），它会在宠物还差最后一小段时把 moveTo 换成 hold；
 * B2 收到"非 climb 指令"时若脚下 24px 内刚好有可站表面，就吸附上去（补完最后一段攀爬上沿），
 * 否则才松手自由落体。24 = B1 的 16px 判定 + 8px 余量。
 */
export const CLIMB_SETTLE_SNAP_EPS_PX = 24

/** teleport / 初始化时判断"正好落在表面上"的容差（px）。 */
export const TELEPORT_SNAP_EPS_PX = 2

/**
 * 支撑面重匹配的 top 容差（px）：B5 遮挡裁剪会按可见区间把窗口顶边切成多段并重新编号
 * （`win-X-top` / `win-X-top-1`…），段数变化会让已记录的 `surfaceId` 失效或改指别的段。
 * 站立的宠物在 id 失效时先按「同 windowId + 同 kind + top 差 ≤ 1px」重匹配，
 * 匹配到就沿用新 id 保持 grounded，避免无谓踏空掉落。
 */
export const SUPPORT_REMATCH_TOP_EPS_PX = 1

/** 自由落体跨表面判定容差（px）：严格大于起点，避免从支撑面离开的当帧又"落回"原表面。 */
export const LANDING_EPS_PX = 1e-9

/* -------------------------------------------------------------------------- */
/* 放置（松手 → 吸附窗沿 / 原地站定）                                          */
/* -------------------------------------------------------------------------- */

/**
 * 放置过渡动画速度（px/s）：脚底从松手位置滑到目标位置的基准速度。
 * 距离越远时长越长，但由 {@link PLACEMENT_MIN_DURATION_MS} / {@link PLACEMENT_MAX_DURATION_MS} 夹住，
 * 保证观感为「一下被放上去/放到位」，不会拖太久。
 */
export const PLACEMENT_SPEED_PX_PER_SEC = 1600

/** 放置过渡最短时长（ms；距离 0 时也走完最小过渡，避免瞬移感）。 */
export const PLACEMENT_MIN_DURATION_MS = 120

/** 放置过渡最长时长（ms；再远也快速到位）。 */
export const PLACEMENT_MAX_DURATION_MS = 340

/**
 * 吸附到窗口上沿时，落定位置比 top 高出的距离（px）：
 * 过渡结束后留 2px 落差交给正常自由落体 → 复用落地检测/`landed` 事件/B1 `finishFall`
 * （落地后优先坐下）整条既有管线，而不是另写一套落地状态。
 */
export const PLACEMENT_SURFACE_DROP_GAP_PX = 2

/**
 * 松手「贴沿吸附」容差（px）：脚底与某条窗沿 top 相差 ≤ 该值、且竖直速度很小（视为"放下"而不是"甩出"）
 * 时直接落到窗沿上，避免松手瞬间恰好压在沿上却因严格 `top > fromY` 判定而穿过去。
 */
export const RELEASE_SNAP_EPS_PX = 4

/** 贴沿吸附允许的最大竖直速度（px/s）：超过视为甩出，不吸附。 */
export const RELEASE_SNAP_MAX_VY_PX_PER_SEC = 320
