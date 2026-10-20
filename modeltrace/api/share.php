<?php
/**
 * modeltrace/api/share.php —— 保存 / 读取分享的归因报告
 * =====================================================================
 * POST { snapshot, urlMode }  → { ok, id, reused? }
 *   把一份归因快照存成 <MT_DATA_DIR>/shares/<id>.json，前端据此生成
 *   /s/<id> 短链（整条约 40 字符，对比原来的 #data= 长链约 1200 字符）。
 *   id 是 9 位随机码；**同一份报告重复分享仍复用同一个 id** —— 靠文档里的内容哈希
 *   `_h` 查重（见 mt_share_find_by_hash），命中就返回 reused:true，
 *   不会堆出内容相同的副本，也不刷新 mtime（免得旧报告永远不被回收）。
 *
 * GET ?id=xxx                 → { ok, report }
 *   只读返回快照，无认证。report 页加载时用。
 *
 * 这是本站**唯一**无需登录的写入端点（检测请求一律浏览器直连、不经服务器），
 * 所以「公开写入端点四件套」一个不少：
 *   ① 截断    mt_read_json() 按 CONTENT_LENGTH 提前拒 + 实际长度兜底；
 *             落盘前字段白名单 + 逐字段截断（rank 6 条 / responses 20 条 / 字符串 512 字符）
 *   ② 封顶    单档 MT_MAX_SHARE_BYTES，总量 MT_MAX_SHARES
 *   ③ 限流    mt_rate_limit('share')，按 REMOTE_ADDR 分桶
 *   ④ 回收    超量删最旧的，而不是拒绝新写入
 *
 * 为什么不拒绝新写入：匿名端点上「拒绝」惩罚的是正常分享者（浏览量大的报告
 * 会把配额占满，后来者全被拒），而旧报告的价值随时间递减。删旧留新是这两者里
 * 唯一不伤害人的选择。
 *
 * ⚠️ URL 口径：分享的报告会被外人打开，所以中转站地址默认只留 host。
 *    服务端**不信客户端**传来的 urlMode —— 声称 host 时自己从 u 里重新解析
 *    出 host 覆盖，绕过前端直接 POST 完整 URL 也存不进 path / 查询串。
 *    取值收敛在 host / none / full 三档（见文件末尾的白名单），
 *    其中 none 落成空串、full 只为读取历史链接而保留。
 * ===================================================================== */

declare(strict_types=1);
require __DIR__ . '/_common.php';

header('X-Robots-Tag: noindex');

/** 单个分享文件上限：快照白名单后本就几 KB，给宽一点防异常。 */
define('MT_MAX_SHARE_BYTES', max(4 * 1024, min(8 * 1024 * 1024, (int) mt_cfg($__cfg, 'MT_MAX_SHARE_BYTES', 128 * 1024))));

/** 分享总数上限。每条几 KB，1000 条约 2~4 MB。
 *  下界只设 1：这是「容量」而不是「安全阈值」，配小了只是存得少，不该被钳制 ——
 *  早先写成 max(10, ...)，结果上限 ≤10 时根本配不下去，回收逻辑等于关着（测试里踩到的）。 */
define('MT_MAX_SHARES', max(1, min(100000, (int) mt_cfg($__cfg, 'MT_MAX_SHARES', 1000))));

/** 单次回收删掉的比例：一次删够，避免每来一条就 glob 一次全目录。 */
const MT_SHARE_SWEEP_RATIO = 0.1;

/** id 长度：1 位前缀 'a' + 9 位 base36 随机码。
 *
 *  为什么从「27 位内容哈希」换成「9 位随机」：
 *  链接是要发到微信 / QQ / 群里的，id 每一位都直接决定读者看到多长的一串乱码。
 *  旧 id 28 字符 + `report?id=` 前缀，整条 URL 70 字符；新 id 10 字符 + `/s/` 前缀
 *  （nginx 重写，见 README），整条 40 字符出头 —— 短到能在聊天框里单行完整显示。
 *
 *  ⚠️ 缩短后**不能再靠哈希本身保证唯一**，改成「写之前先查有没有同样的内容」：
 *     mt_share_find_by_hash() 扫已有文件比对 _h，命中就复用它的 id 与文件。
 *     这比哈希寻址多一次目录扫描，但 share 是低频写入端点（一次检测最多写一次），
 *     且扫的是自家 1000 个以内的几 KB 小文件，代价可以忽略。
 *
 *  9 位 base36 = 36^9 ≈ 1.0e14 ≈ 46.5 bit。按上限 1000 条报告算，
 *  生日碰撞概率 ≈ 1e6 / (2 × 1.0e14) ≈ 5e-9 —— 比磁盘出错的概率还低。
 *  （真要撞上，写入时那次查询会命中「不同内容用了同一个 id」，
 *    下面 MT_SHARE_ID_RETRY 次重试会换一个码，不会互相覆盖。）
 *  随机码用 random_int 取，不用内容哈希截断：截断会让「同一内容必得同一 id」
 *  这个性质只剩概率意义，而我们已经用 _h 显式实现了复用，不需要它。 */
const MT_SHARE_ID_LEN = 9;

/** 生成随机 id 时的重试次数：撞上已有文件就换一个码重来。
 *  9 位空间下 1000 条时单次碰撞概率约 1e-11，5 次足够应对任何真实场景；
 *  真正的兜底是循环结束后报错，而不是覆盖别人的报告。 */
const MT_SHARE_ID_RETRY = 5;

/** 内容哈希在文档里的字段名。
 *
 *  它**不参与** mt_share_hash_input（那里会剔除），因为它的用途是「查重」而不是「寻址」：
 *  同一份报告重复分享时，用它来找出上次那条记录、复用那条的 id。 */
const MT_SHARE_HASH_KEY = '_h';

/** 内容哈希（hex），用来判断「这份报告是不是已经存过了」。
 *
 *  哈希输入必须**排除时间字段**（t / savedAt）：它们是「这次请求的时间」，
 *  同一份报告每次分享都不同，算进去等于每次都得到新哈希，复用就白做了。
 *  mt_share_hash_input() 负责剔除。
 *
 *  ⚠️ 内容相同 ≠ id 相同（id 是随机的），所以**不要**用 id 做复用判断 ——
 *     复用的唯一入口是 mt_share_find_by_hash()。 */
function mt_share_content_hash(array $doc): string {
    return hash('sha256', mt_share_hash_input($doc));
}

/** 在已有分享里找出内容相同的那一份，返回文件名（没有则 null）。
 *
 *  这就是「同一份报告重复分享复用同一个链接」的实现。旧版靠内容哈希当 id 直接命中文件，
 *  id 缩短后哈希不再等于文件名，所以要显式扫一遍。
 *
 *  ⚠️ 只读文件头部 512 字节：_h 与 _c 都写在文档最前面（见保存段的数组顺序），
 *     扫 1000 个文件时读全量的代价没必要付。
 *  ⚠️ 匹配不到不算错：内容变了（改了 model / 概率）就该得到新 id、新文件。 */
function mt_share_find_by_hash(string $hash): ?string {
    if ($hash === '') { return null; }
    foreach (glob(mt_dir('shares') . '/a*.json') ?: [] as $file) {
        $fh = @fopen($file, 'rb');
        if ($fh === false) { continue; }
        $head = (string) fread($fh, 512);
        fclose($fh);
        if (preg_match('/"' . MT_SHARE_HASH_KEY . '"\s*:\s*"([0-9a-f]{64})"/', $head, $m) && hash_equals($m[1], $hash)) {
            return $file;
        }
    }
    return null;
}

/** 生成一个没用过的随机 id（'a' + MT_SHARE_ID_LEN 位 base36）。 */
function mt_share_new_id(): string {
    $digits = '0123456789abcdefghijklmnopqrstuvwxyz';
    $dir = mt_dir('shares');
    for ($try = 0; $try < MT_SHARE_ID_RETRY; $try++) {
        $s = 'a';
        for ($i = 0; $i < MT_SHARE_ID_LEN; $i++) {
            $s .= $digits[random_int(0, 35)];
        }
        if (!is_file($dir . '/' . $s . '.json')) { return $s; }
    }
    // 连续撞上 5 次（实际概率 ~1e-55）：宁可报错，也绝不覆盖别人的报告
    mt_out(500, ['ok' => false, 'error' => '生成分享编号失败，请重试']);
}

/** 哈希输入：把落盘文档里的**时间字段**剔除后，做一次键名排序的稳定序列化。
 *
 *  排序是必需的：PHP 数组顺序即插入顺序，而 json_encode 会照此输出 ——
 *  同一份内容若字段顺序不同（例如前端某次改了 key 的书写顺序），hash 就变了，
 *  复用就失效。ksort 递归做一遍，确保「同样的内容」永远得到同样的字节串。 */
function mt_share_hash_input(array $doc): string {
    // 剔除全部「随时间变化」或「由哈希本身派生」的字段：
    //   t / savedAt  这次请求的时间
    //   sv           格式版本号（会随代码升级变化，与报告内容无关）
    //   _c           回收排序用的创建时间（见 MT_SHARE_TS_KEY）
    //   _h           内容哈希本身 —— 它若参与计算，哈希就成了「哈希的哈希」，
    //                而它的用途只是当查重键，掺进去只会让同一份报告算不出同一个值
    unset($doc['t'], $doc['savedAt'], $doc['sv'], $doc[MT_SHARE_TS_KEY], $doc[MT_SHARE_HASH_KEY]);
    mt_ksort_deep($doc);
    return (string) json_encode($doc, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}

/** 递归按键名排序（只对关联数组排序；列表数组保持原序 —— 顺序对它们是语义的一部分）。 */
function mt_ksort_deep(array &$a): void {
    if (!mt_is_list_arr($a)) { ksort($a); }
    foreach ($a as &$v) {
        if (is_array($v)) { mt_ksort_deep($v); }
    }
    unset($v);
}

/** 是不是「列表」（0..n-1 连续下标）。PHP 8 自带 array_is_list，向下兼容自己写一个。 */
function mt_is_list_arr(array $a): bool {
    $i = 0;
    foreach ($a as $k => $_) { if ($k !== $i++) { return false; } }
    return true;
}

/** id 白名单：三种形状都收，且只收这几种精确形状（定长，不留模糊空间）。
 *    ① 新格式：'a' + 9 位 base36 随机码（共 10 字符）
 *    ② 上一版：'a' + 27 位 base36 内容哈希（共 28 字符）
 *    ③ 最旧版：'a' + 11 位 base36 时间戳 + 12 位 hex（共 24 字符）
 *  后两种必须继续放行 —— 线上已经发出去的分享链接不能因为改了生成方式就全部失效。
 *  （②③ 的链接仍指向同一份报告；只是新链接一律用 ① 的短形状。）
 *  只允许这几种形状，也就杜绝了 ../ 之类的路径穿越。 */
function mt_valid_share_id(string $id): bool {
    return (bool) preg_match('/^a(?:[a-z0-9]{11}[a-f0-9]{12}|[a-z0-9]{27}|[a-z0-9]{9})$/', $id);
}

/** 文档里记录「第一次写入」的毫秒时间戳，供回收排序用。
 *
 *  为什么要单独存一个字段、而不靠文件 mtime：
 *  随机 id 里没有时间信息，排序只能另找依据；而 PHP 的 stat **只有秒级精度**，
 *  同一秒内分享的多份报告 mtime 完全相同 —— 排序退化成按文件名（也就是随机码）排，
 *  删哪一条纯属偶然。「最旧的先删」就变成了随机删，这正是回收要避免的。
 *  所以服务端在文档里自己记一笔毫秒时间，排序按它，精确且可控。
 *
 *  ⚠️ 它**不参与哈希**（mt_share_hash_input 会剔除）：把「这次请求的时间」算进哈希，
 *     同一份报告每次分享都会算出不同的查重键，复用直接失效。 */
const MT_SHARE_TS_KEY = '_c';

/** 取一份落盘文档的创建时间（毫秒）。没有这个字段（旧文件）就退回 mtime（秒 → 毫秒）。 */
function mt_share_created_at(string $file): int {
    $fh = @fopen($file, 'rb');
    if ($fh !== false) {
        $head = (string) fread($fh, 256);       // 该字段写在文档最前面，读个头就够，不必解析整个 JSON
        fclose($fh);
        if (preg_match('/"' . MT_SHARE_TS_KEY . '"\s*:\s*(\d+)/', $head, $m)) {
            return (int) $m[1];
        }
    }
    $mtime = @filemtime($file);
    return $mtime === false ? 0 : $mtime * 1000;
}

/** 回收用的排序键：创建时间（毫秒）升序，文件名兜底保证顺序确定、可复现。 */
function mt_share_sort_key(string $file): array {
    return [mt_share_created_at($file), basename($file, '.json')];
}

/** 回收：超过 MT_MAX_SHARES 时删掉最旧的一批。返回删除条数。 */
function mt_share_sweep(): int {
    $dir = mt_dir('shares');
    $files = glob($dir . '/a*.json') ?: [];
    $over = count($files) - MT_MAX_SHARES;
    if ($over <= 0) { return 0; }

    // 一次至少删 1 条，且按比例多删一点，避免下次请求又来 glob 一遍
    $drop = max(1, (int) ceil(MT_MAX_SHARES * MT_SHARE_SWEEP_RATIO), $over);
    usort($files, static fn($x, $y) => mt_share_sort_key($x) <=> mt_share_sort_key($y));

    $n = 0;
    foreach (array_slice($files, 0, $drop) as $f) {
        if (@unlink($f)) { $n++; }
    }
    return $n;
}

/** 短字符串截断（按字符而非字节，免得把中文截成半个字） */
function mt_share_str($v, int $max = 512): string {
    $s = (string) (is_scalar($v) ? $v : '');
    return mb_strlen($s) > $max ? mb_substr($s, 0, $max) : $s;
}

/** 概率：夹到 0~1，非法值给 null（报告页会显示「—」，比显示 NaN 好） */
function mt_share_prob($v): ?float {
    if (!is_numeric($v)) { return null; }
    $f = (float) $v;
    return ($f < 0 || $f > 1) ? null : $f;
}

/** 整数：夹到非负 */
function mt_share_int($v): int {
    return is_numeric($v) ? max(0, (int) $v) : 0;
}

/**
 * 图表原料：每份回答的数字序列。
 *
 * 接受两种形状，因为两种都合理、而且**认错了不会报错、只会静默画不出图**：
 *   { index, numbers }   前端 store.buildSnapshot() 产出的对象形式
 *   [ index, numbers ]   同一份数据压成数组（省 key 名，历史快照就是这样）
 * 早先只认数组形式，用对象形式提交时 $row[1] 取到的是 undefined —— 不报错、数字全空、
 * 分享页画出一张空图。服务端对「同一语义的两种常见写法」都该认，别让调用方去猜。
 *
 * ⚠️ 存**原始数字**而不是算好的分布 / z 分：指纹库会随仓库更新（加模型、重建质心），
 * 派生数据的数组下标与当时的库绑定，用新库渲染就错位、把图画错；
 * 原始数字让报告页用当前库重算，索引永远对得上。代价只有约 3KB（实测 3×300 约 3.2KB）。
 *
 * 数字过滤到 1..355：这是 parseNumbers 的合法域，也是 355 维分布的定义域。
 * 不夹的话攻击者能塞百万级数字把图表的数组分配撑爆（体积上限挡不住「值域异常」）。
 */
function mt_share_raw_numbers($v): array {
    $out = [];
    foreach (array_slice(is_array($v) ? $v : [], 0, 3) as $row) {
        if (!is_array($row)) { continue; }
        $idx = $row[0] ?? $row['index'] ?? 0;
        $rawNums = is_array($row[1] ?? null) ? $row[1] : ($row['numbers'] ?? null);
        $clean = [];
        foreach (is_array($rawNums) ? array_slice($rawNums, 0, 400) : [] as $n) {
            $n = is_numeric($n) ? (int) $n : 0;
            if ($n >= 1 && $n <= 355) { $clean[] = $n; }
        }
        $out[] = [mt_share_int($idx), $clean];
    }
    return $out;
}

/**
 * 清洗快照：字段白名单 + 逐字段截断 + URL 口径。
 * 白名单和前端 buildSnapshot() 一一对应；这里多一个都不留 ——
 * 落盘的东西将来会被陌生人打开，白名单是唯一挡得住「以后有人往里塞新字段」的地方。
 */
function mt_clean_snapshot(array $in, string $urlMode): array {
    $vd = is_array($in['vd'] ?? null) ? $in['vd'] : [];
    $code = mt_share_str($vd['code'] ?? '', 32);
    if ($code === '') { return []; }        // 没有结论报告页画不出来，直接不收

    $url = mt_share_str($in['u'] ?? '', 2048);
    $host = mt_share_host($url);
    // 口径在这一层定死：host 只留域名，full 才原样保留（历史兼容），none 落成空串。
    // none 走空串而不是「新增一个隐藏标志」：前端读回时 hostOf('') === ''，
    // 报告卡的「检测站点」格已经有 `|| '—'` 兜底链，自然渲染成破折号，前端零改动。
    if ($urlMode === 'none') { $url = ''; }
    elseif ($urlMode !== 'full') { $url = $host; }

    $rank = [];
    foreach (array_slice(is_array($in['rk'] ?? null) ? $in['rk'] : [], 0, 6) as $x) {
        if (!is_array($x)) { continue; }
        $model = mt_share_str($x[0] ?? '', 128);
        if ($model === '') { continue; }
        $rank[] = [$model, mt_share_prob($x[1] ?? null)];
    }

    $resp = [];
    foreach (array_slice(is_array($in['rs'] ?? null) ? $in['rs'] : [], 0, 20) as $x) {
        if (!is_array($x)) { continue; }
        $resp[] = [mt_share_int($x[0] ?? 0), mt_share_int($x[1] ?? 0), mt_share_str($x[2] ?? '', 128), mt_share_prob($x[3] ?? null)];
    }

    return [
        // 'sv' 是**快照格式版本**，用来判断这份旧分享有哪些字段：
        //   1 = 只有报告卡（结论 / 概率 / 候选排名）
        //   3 = 多了图表原料 rn / bb，分享页可以重算并画出两个分布图
        // 报告页按它（更准确地说：按 rn 是否为空）决定要不要画图 —— 缺原料的旧分享只显示报告卡。
        // ⚠️ 这个字段**不能**叫 'v'：前端 readSnapshot() 的短名表里 'v' 是「接口变体」
        // （variant），而 buildSnapshot 的短名快照本身就带 v。早先这里写 'v' => 1，
        // 生成的文档因此多了一个假 variant，报告页读到 variant=1 而结论为空 ——
        // 后端加字段前必须对一遍前端的短名表，别用单字母。
        'sv'   => 3,
        't'    => mt_share_str($in['t'] ?? date('c'), 40),
        'u'    => $url,                                // 已按 urlMode 定过口径
        'm'    => mt_share_str($in['m'] ?? '', 512),
        'c'    => mt_share_str($in['c'] ?? '', 512),
        'v'    => mt_share_str($in['v'] ?? '', 128),   // 接口变体
        'vd'   => ['code' => $code, 'sameFamily' => !empty($vd['sameFamily'])],
        'p'    => mt_share_prob($in['p'] ?? null),
        'pr'   => mt_share_str($in['pr'] ?? '', 512),
        'n'    => mt_share_int($in['n'] ?? 0),
        'a'    => mt_share_int($in['a'] ?? 0),
        'f'    => mt_share_str($in['f'] ?? '', 64),
        'tot'  => mt_share_int($in['tot'] ?? 0),
        'sim'  => mt_share_prob($in['sim'] ?? null),
        'rk'   => $rank,
        'rs'   => $resp,
        'pa'   => !empty($in['pa']),
        'px'   => !empty($in['px']),
        'um'   => $urlMode,                            // 当时选的口径，报告页据此措辞
        // ---- 图表原料（分享页画「指纹叠印 / 指纹罗盘」用）----
        // 只存这次检测独有的数据：每份回答的原始数字。18 个模型的基准分布不在这里 ——
        // 它在 data/bank/unified_bank.json 里、已随仓库提交、报告页自己 fetch
        //（那部分 150KB，随每次分享重复存等于白烧磁盘）。
        'rn'   => mt_share_raw_numbers($in['rn'] ?? []),
        'bb'   => mt_share_str($in['bb'] ?? '', 40),   // 建库时间：报告页据此标注基准版本
        'savedAt' => date('c'),
    ];
}

/** 从 URL 取 host；取不到就返回空串（前端会显示「—」）。 */
function mt_share_host(string $url): string {
    if ($url === '') { return ''; }
    $withScheme = preg_match('#^[a-z][a-z0-9+.-]*://#i', $url) ? $url : 'https://' . $url;
    $host = (string) parse_url($withScheme, PHP_URL_HOST);
    if ($host !== '') { return mt_share_str($host, 255); }
    // parse_url 对畸形输入会返回 false；退化成手工切分，至少别把整条 URL 漏出去
    $s = preg_replace('#^[a-z][a-z0-9+.-]*://#i', '', $url);
    $s = (string) preg_replace('#[/?#].*$#', '', (string) $s);
    return mt_share_str($s, 255);
}

/* ===================== 读取 ===================== */

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'GET') {
    mt_rate_limit('share_get');          // 读也限流：分享链会被爬虫和 IM 预览抓
    $id = (string) ($_GET['id'] ?? '');
    if (!mt_valid_share_id($id)) { mt_out(400, ['ok' => false, 'error' => 'bad id']); }

    $file = mt_dir('shares') . '/' . $id . '.json';
    if (!is_file($file)) { mt_out(404, ['ok' => false, 'error' => 'report not found']); }

    $report = json_decode((string) @file_get_contents($file), true);
    if (!is_array($report)) { mt_out(500, ['ok' => false, 'error' => 'corrupt report']); }
    mt_out(200, ['ok' => true, 'report' => $report]);
}

/* ===================== 保存 ===================== */

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    mt_out(405, ['ok' => false, 'error' => 'use GET or POST']);
}

mt_rate_limit('share');

$in = mt_read_json();
if (!is_array($in['snapshot'] ?? null)) { mt_out(400, ['ok' => false, 'error' => '缺少 snapshot']); }

// urlMode 白名单：host（只留域名）/ none（完全不显示）/ full（历史遗留）。
// 'full' 只保留**读取兼容** —— 线上已经发出去的完整地址链接照常能打开，
// 但前台已不再提供这个选项（端点路径可能带账号信息，不值得公开）。
// 非法值一律落回 host：默认落在更安全的那一侧，且不报错打断正常分享。
$urlMode = in_array($in['urlMode'] ?? '', ['host', 'none', 'full'], true) ? $in['urlMode'] : 'host';

$doc = mt_clean_snapshot($in['snapshot'], $urlMode);
if (!$doc) { mt_out(400, ['ok' => false, 'error' => '空报告']); }

/* 先算内容哈希（查重键），再落 _c 创建时间。
 *
 * ⚠️ 顺序要紧：_h 与 _c 都必须写在文档**最前面** —— mt_share_find_by_hash 与
 *    mt_share_created_at 都只读文件头 512 / 256 字节，字段一旦挪到后面就查不到，
 *    表现为「同一份报告每次都生成新链接」（复用静默失效，不报错）。
 *    两者都被 mt_share_hash_input 剔除，所以不影响查重结果。 */
$hash = mt_share_content_hash($doc);
$doc = [MT_SHARE_HASH_KEY => $hash, MT_SHARE_TS_KEY => (int) round(microtime(true) * 1000)] + $doc;

$json = json_encode($doc, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
if (strlen($json) > MT_MAX_SHARE_BYTES) { mt_out(413, ['ok' => false, 'error' => '报告过大']); }

/* 复用点：扫已有分享，内容哈希相同的那一份就是同一份报告 → 返回它原有的 id。
 *
 * 这是「同一条检测历史点两次分享，得到同一个链接」的实现（用户明确要的行为），
 * 也是不堆重复副本的原因。id 缩短成随机码之后，复用不再靠文件名命中，
 * 而是靠这里的显式查找 —— 少写一次盘，也保住文件原有的创建时间
 * （回收排序按 _c，每次重复分享都刷新它会让老报告永远轮不到被回收）。
 *
 * ⚠️ 只有**清洗后**的文档才参与比对（已过白名单、已按 urlMode 定过口径），
 *   所以「哈希相同」等价于「报告相同」，不存在 A 的内容顶掉 B 的文件。 */
$existing = mt_share_find_by_hash($hash);
if ($existing !== null) {
    mt_out(200, ['ok' => true, 'id' => basename($existing, '.json'), 'reused' => true]);
}

$id = mt_share_new_id();
$file = mt_dir('shares') . '/' . $id . '.json';

mt_write_atomic($file, $json);

// 保存成功后才回收：这次写入永远进得去，代价是短暂的超量（下次请求收拾干净）
mt_share_sweep();

mt_out(200, ['ok' => true, 'id' => $id]);
