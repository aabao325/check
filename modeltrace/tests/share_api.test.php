<?php
/**
 * tests/share_api.test.php —— 分享端点：落盘闸门、URL 口径、限流回收
 *
 * 起 PHP 内置服务器打真实的 share.php（mt_out 会 exit，只能从外部打 HTTP 来测状态码），
 * 数据目录指到临时目录，测完删除。用法：php modeltrace/tests/share_api.test.php
 *
 * 锁住的事：
 *   ① 合法快照能存能读回，id 形如 a<9位base36 随机码>（共 10 字符）
 *   ①b **同一份报告重复分享复用同一个 id**（靠 _h 内容哈希查重），且不刷新 mtime
 *   ①c 旧的「内容哈希」「时间戳 + 随机」形状仍然可读（线上老链接不能失效）
 *   ② 缺 vd（结论）的空报告被拒
 *   ③ urlMode=host 时服务端**自己**从完整 URL 里重新解析 host 覆盖掉 ——
 *      不信客户端，绕过前端直接 POST u=<完整地址> 也存不进完整地址
 *   ④ 白名单：多余字段不落盘、rank 截到 6 条、responses 截到 20 条、长字符串被截断
 *   ⑤ 请求体过大 413；限流 429
 *   ⑥ 超量时删最旧的分享（而不是拒绝新请求 —— 匿名端点拒绝写入体验很差）
 */

$root = realpath(__DIR__ . '/..');
$tmp = sys_get_temp_dir() . '/mt-share-test-' . bin2hex(random_bytes(4));
mkdir($tmp, 0777, true);
$port = 18000 + random_int(0, 999);

$env = array_merge(getenv(), [
    'MT_DATA_DIR' => $tmp,
    'MT_MAX_SHARES' => '5',
    'MT_RATE_LIMIT' => '40',
    'MT_RATE_WINDOW' => '60',
]);
$cmd = [PHP_BINARY, '-S', "127.0.0.1:$port", '-t', $root];
$proc = proc_open($cmd, [0 => ['pipe', 'r'], 1 => ['file', $tmp . '/server.log', 'a'], 2 => ['file', $tmp . '/server.log', 'a']], $pipes, $root, $env);
for ($i = 0; $i < 50; $i++) { if (@fsockopen('127.0.0.1', $port)) break; usleep(100000); }

$pass = 0; $fail = 0;
function ok($cond, string $msg): void { global $pass, $fail; if ($cond) { $pass++; return; } $fail++; fwrite(STDERR, "FAIL: $msg\n"); }

/** 打 share.php。$method 为 GET 时 $body 只用来拼 query。 */
function call(string $method, $body = null, string $query = ''): array {
    global $port;
    $url = "http://127.0.0.1:$port/api/share.php" . ($query !== '' ? "?$query" : '');
    $ch = curl_init($url);
    $opts = [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 20];
    if ($method === 'POST') {
        $opts[CURLOPT_POST] = true;
        $opts[CURLOPT_POSTFIELDS] = is_string($body) ? $body : json_encode($body);
        $opts[CURLOPT_HTTPHEADER] = ['Content-Type: application/json'];
    }
    curl_setopt_array($ch, $opts);
    $out = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return [$code, json_decode((string) $out, true) ?: ['_raw' => $out]];
}

/** 一份最小合法快照 */
function snap(array $over = []): array {
    return array_merge([
        'id' => 'mtest1', 't' => '2026-10-13T12:00:00.000Z',
        'u' => 'https://relay.example.com/v1/messages?key=secret#frag', 'm' => 'claude-opus-5', 'c' => 'claude-opus-5',
        'vd' => ['code' => 'match', 'sameFamily' => true], 'p' => 0.97, 'pr' => 'claude-opus-5',
        'n' => 3, 'a' => 4, 'f' => 'anthropic', 'tot' => 300, 'sim' => 0.81,
        'rk' => [['claude-opus-5', 0.97], ['gpt-5.6', 0.02]],
        'rs' => [[1, 104, 'claude-opus-5', 0.97]],
        // 图表原料：每份回答的原始数字序列（报告页据此用当前指纹库重算图表）
        'rn' => [[1, array_fill(0, 300, 7)], [2, array_fill(0, 300, 9)]],
        'bb' => '2026-10-09T00:00:00Z',
    ], $over);
}

try {
    // ---- ① 存 / 读 ----
    [$c, $j] = call('POST', ['snapshot' => snap(), 'urlMode' => 'host']);
    ok($c === 200 && ($j['ok'] ?? false) === true, "合法快照应保存成功，实际 $c");
    $id = $j['id'] ?? '';
    // 新格式：'a' + 9 位 base36 随机码（共 10 字符）。
    // ⚠️ 长度是**功能需求**不是实现细节：整条分享链接要短到能在微信里单行显示，
    //     id 每多一位都直接顶到用户眼前。改长之前先想清楚为什么。
    ok((bool) preg_match('/^a[a-z0-9]{9}$/', $id), "id 格式应为 a<9位base36随机码>，实际 $id");
    ok(strlen($id) === 10, "id 长度应恒为 10，实际 " . strlen($id));
    ok(($j['reused'] ?? false) === false, '首次分享不应标记 reused');
    // 落盘文档必须带内容哈希 _h，且它不参与哈希计算（否则自己哈希自己，永远算不出稳定值）
    $saved0 = json_decode((string) @file_get_contents("$tmp/shares/$id.json"), true);
    ok(isset($saved0['_h']) && (bool) preg_match('/^[0-9a-f]{64}$/', (string) $saved0['_h']), '落盘文档应带 64 位 hex 的 _h 查重键');

    [$c, $j] = call('GET', null, 'id=' . urlencode($id));
    ok($c === 200 && ($j['report']['m'] ?? '') === 'claude-opus-5', "读回应返回快照，实际 $c");
    ok(($j['report']['vd']['code'] ?? '') === 'match', '结论字段应原样读回');

    // ---- ①b 同一份报告重复分享 → 复用同一个 id ----
    // 这是用户明确要的行为：同一条检测历史点两次分享，不该在服务器上留下两份一样的报告，
    // 也不该给出两个不同的链接（那样「复用第一次生成的分享链接」就无从谈起）。
    $firstDoc = json_decode((string) @file_get_contents("$tmp/shares/$id.json"), true);
    $firstCreated = $firstDoc['_c'] ?? null;
    ok(is_int($firstCreated), "落盘文档应带创建时间 _c（回收排序用），实际 " . var_export($firstCreated, true));
    usleep(1100000);                               // 跨过 1 秒：若复用时重写了盘，_c 就会变
    [$c, $j2] = call('POST', ['snapshot' => snap(), 'urlMode' => 'host']);
    ok(($j2['id'] ?? '') === $id, "同一份报告应复用同一个 id，实际 " . ($j2['id'] ?? '(空)'));
    ok(($j2['reused'] ?? false) === true, '复用时应标记 reused=true');
    $again = json_decode((string) @file_get_contents("$tmp/shares/$id.json"), true);
    ok(($again['_c'] ?? null) === $firstCreated, '复用不该刷新创建时间（否则旧报告永远轮不到被回收）');
    // 内容真变了（哪怕只差一个字段）就必须给新 id —— 否则会互相覆盖
    [$c, $j3] = call('POST', ['snapshot' => snap(['m' => 'gpt-5.6']), 'urlMode' => 'host']);
    ok(($j3['id'] ?? '') !== $id, '内容不同必须得到不同的 id');
    // _h / _c 都不参与内容哈希：上面那份改了 model 的快照，复用与否只该由报告内容决定，
    // 不该因为「两次请求的时间不同」或「查重键本身混进了哈希输入」而变。
    // 若 _h 混进了哈希输入，它就成了「自己哈希自己」，下面这条会假失败。
    [$c, $j3b] = call('POST', ['snapshot' => snap(['m' => 'gpt-5.6']), 'urlMode' => 'host']);
    ok(($j3b['id'] ?? '') === ($j3['id'] ?? ''), '_h / _c 不得参与内容哈希（否则同一份报告每分享一次就换个链接）');
    ok(($j3b['reused'] ?? false) === true, '改过内容的快照第二次分享也应命中复用');

    // ---- ①c 旧形状的 id 仍可读（线上老链接） ----
    // 老链接在新代码里只是「读得到、但不会再生成」。写一个老形状的文件进去，验证白名单放行。
    $legacy = 'a' . str_pad('0', 11, '0') . 'aabbccddeeff';
    @file_put_contents("$tmp/shares/$legacy.json", json_encode(['m' => 'legacy', 'vd' => ['code' => 'match']]));
    [$c, $j4] = call('GET', null, 'id=' . urlencode($legacy));
    ok($c === 200 && ($j4['report']['m'] ?? '') === 'legacy', "旧形状 id 仍应可读，实际 $c");


    // ---- ② 空报告被拒 ----
    [$c] = call('POST', ['snapshot' => ['m' => 'x'], 'urlMode' => 'host']);
    ok($c === 400, "缺结论的空报告应 400，实际 $c");

    // ---- ③ urlMode=host：服务端自己解析 host，不信客户端 ----
    [$c, $j] = call('POST', ['snapshot' => snap(), 'urlMode' => 'host']);
    $idHost = $j['id'] ?? '';
    $disk = (string) @file_get_contents("$tmp/shares/$idHost.json");
    ok($disk !== '' && strpos($disk, 'secret') === false, 'urlMode=host 时完整 URL（含查询串）绝不能落盘');
    ok(strpos($disk, 'relay.example.com') !== false, 'host 应保留');
    ok(strpos($disk, '"path"') === false && strpos($disk, '/v1/messages') === false, 'path 不应落盘');

    // 绕过前端：直接 POST 完整 URL 但声称 host 模式 —— 服务端必须仍截断
    [$c, $j] = call('POST', ['snapshot' => snap(['u' => 'https://evil.example.com/deep/path?token=abc']), 'urlMode' => 'host']);
    $idSneak = $j['id'] ?? '';
    $sneak = (string) @file_get_contents("$tmp/shares/$idSneak.json");
    ok(strpos($sneak, 'token=abc') === false && strpos($sneak, 'deep/path') === false, '声称 host 模式时服务端应重新解析 host，path/查询串不得落盘');
    ok(strpos($sneak, 'evil.example.com') !== false, '重新解析出的 host 应保留');

    // urlMode=full 时完整保存（**只为读取线上旧链接而保留**，前台已不再产这个值）
    [$c, $j] = call('POST', ['snapshot' => snap(), 'urlMode' => 'full']);
    $idFull = $j['id'] ?? '';
    $full = (string) @file_get_contents("$tmp/shares/$idFull.json");
    ok(strpos($full, '/v1/messages') !== false, 'urlMode=full 时应保留完整 URL');
    ok(strpos($full, '"um":"full"') !== false || strpos($full, '"um": "full"') !== false, '应记录当时选择的 urlMode');

    // ---- ③a urlMode=none：地址整条不落盘 ----
    // 前台「不显示地址」这一项的落盘结果必须是空串 —— 报告页靠 hostOf('') === '' 渲染成
    // 破折号，所以这里断言的是「连域名都不剩」，而不是「域名还在只是前端不画」。
    [$c, $j] = call('POST', ['snapshot' => snap(), 'urlMode' => 'none']);
    $idNone = $j['id'] ?? '';
    ok($c === 200 && $idNone !== '', "urlMode=none 应正常生成链接，实际 $c");
    $none = (string) @file_get_contents("$tmp/shares/$idNone.json");
    ok(strpos($none, 'relay.example.com') === false, 'urlMode=none 时域名也不该落盘');
    ok(strpos($none, 'secret') === false && strpos($none, '/v1/messages') === false, 'urlMode=none 时 path/查询串不该落盘');
    ok(strpos($none, '"um":"none"') !== false || strpos($none, '"um": "none"') !== false, '应记录 urlMode=none');
    // 与 host 口径算出的哈希不同 → id 也不同，两者各自留一条，不会互相覆盖
    ok($idNone !== $idHost, 'none 与 host 是两份内容，id 不该相同');

    // 非法 urlMode 一律落回 host（默认落在更安全的一侧，且不打断分享）
    [$c, $j] = call('POST', ['snapshot' => snap(), 'urlMode' => 'FULL']);
    $idBad = $j['id'] ?? '';
    $bad = (string) @file_get_contents("$tmp/shares/$idBad.json");
    ok(strpos($bad, '/v1/messages') === false, '大小写/未知的 urlMode 应落回 host，不得原样公开完整地址');
    ok(strpos($bad, 'relay.example.com') !== false, '落回 host 后域名应保留');

    // ---- ③b 版本号字段不能和前端短名撞车 ----
    // 前端 readSnapshot 的短名表里 'v' 是「接口变体」。后端若拿 'v' 当格式版本号，
    // 报告页会读出一个假的 variant，而且 —— 更糟 —— 后端落盘必带 savedAt，
    // readSnapshot 的哨兵判断会把文档误判成长名格式、整段翻译被跳过，结论直接空白。
    [$c, $j] = call('POST', ['snapshot' => snap(['v' => 'anthropic-thinking']), 'urlMode' => 'host']);
    $doc = json_decode((string) @file_get_contents("$tmp/shares/" . ($j['id'] ?? '') . ".json"), true);
    ok(($doc['v'] ?? null) === 'anthropic-thinking', "snapshot 的 v 应原样落盘为接口变体，实际 " . json_encode($doc['v'] ?? null));
    ok(($doc['sv'] ?? null) === 3, '格式版本号应落在 sv 字段（当前为 3：含图表原料），而不是 v');

    // ---- ③c 图表数据：355 维分布 + 每份 z 分，且要夹住分量个数 ----
    // 分享页要画「指纹叠印 / 指纹罗盘」，靠的就是这两个字段：每份回答的**原始数字序列**
    // 加建库时间（基准分布由报告页自己 fetch 指纹库，那部分 150KB 不该随每次分享重复存）。
    // 存原始数字而不是算好的 z 分 / 合并分布：库会随仓库更新（加模型、重建质心），
    // 派生数据的索引顺序会和当前库错位、图表画错；原始数字让报告页用当前库重算，永远对齐。
    [$c, $j] = call('POST', ['snapshot' => snap(), 'urlMode' => 'host']);
    $chart = json_decode((string) @file_get_contents("$tmp/shares/" . ($j['id'] ?? '') . ".json"), true);
    ok(($chart['sv'] ?? null) === 3, '格式版本号应升到 3（新增图表原料）');
    ok(count($chart['rn'] ?? []) === 2, '每份回答的原始数字应保留，实际 ' . count($chart['rn'] ?? []));
    ok(count($chart['rn'][0][1] ?? []) === 300, '第一份回答的数字序列应完整');
    ok(($chart['bb'] ?? '') === '2026-10-09T00:00:00Z', '建库时间应保留，供报告页标注基准版本');

    // 异常输入：份数与单份数字个数都必须由服务端夹住，数值范围也要过滤。
    // 注意别拿全超域的数字来测份数/长度 —— 它们会被值域过滤掉，测出来的长度是 0，
    // 看起来像「没夹住份数」。合法值与非法值混着放，两个断言才各测各的。
    $mixed = array_merge(array_fill(0, 5000, 7), [999, 0, -3]);
    [$c, $j] = call('POST', ['snapshot' => snap([
        'rn' => array_fill(0, 50, [1, $mixed]),
    ]), 'urlMode' => 'host']);
    $big = json_decode((string) @file_get_contents("$tmp/shares/" . ($j['id'] ?? '') . ".json"), true);
    ok(count($big['rn'] ?? []) === 3, '回答份数应截到 3，实际 ' . count($big['rn'] ?? []));
    ok(count($big['rn'][0][1] ?? []) === 400, '单份数字个数应截到 400，实际 ' . count($big['rn'][0][1] ?? []));
    ok(array_sum($big['rn'][0][1] ?? [0]) === 400 * 7, '999 / 0 / -3 这类超域数字应被丢弃');

    // 两种形状都要认：前端发的是对象（{index, numbers}），历史快照压成数组（[index, numbers]）。
    // 只认一种时另一种会**静默**变成空数字 —— 不报错、只是图是空的，属于最难发现的那类 bug。
    [$c, $j] = call('POST', ['snapshot' => snap([
        'rn' => [['index' => 1, 'numbers' => array_fill(0, 120, 42)]],
    ]), 'urlMode' => 'host']);
    $obj = json_decode((string) @file_get_contents("$tmp/shares/" . ($j['id'] ?? '') . ".json"), true);
    ok(count($obj['rn'][0][1] ?? []) === 120, '对象形式的 {index, numbers} 也应被正确读取，实际 ' . count($obj['rn'][0][1] ?? []));
    ok(($obj['rn'][0][0] ?? null) === 1, '对象形式的 index 应被保留');

    // 旧格式（无图表原料）仍要收得下 —— 线上已有的分享就是这个样子，不能因为加字段就存不进去。
    // ⚠️ 快照内容必须与别处不同：内容寻址下「同样的内容」会复用已有 id，
    // 于是这次 POST 不写盘、读回来的是早先那份文件，断言就测错了对象。
    [$c, $j] = call('POST', ['snapshot' => snap(['rn' => null, 'bb' => null, 'm' => 'legacy-no-charts']), 'urlMode' => 'host']);
    ok($c === 200, "无图表原料的旧格式快照仍应可存，实际 $c");
    $old = json_decode((string) @file_get_contents("$tmp/shares/" . ($j['id'] ?? '') . ".json"), true);
    ok(($old['rn'] ?? null) === [], '缺失的 rn 应落成空数组，报告页据此不画图');
    ok(($old['m'] ?? '') === 'legacy-no-charts', '读回的应是这次写入的那份文档');

    // ---- ④ 白名单与截断 ----
    $dirty = snap([
        'apiKey' => 'sk-must-not-be-stored',
        'evil' => str_repeat('y', 5000),
        'rk' => array_fill(0, 30, ['claude-opus-5', 0.5]),
        'rs' => array_fill(0, 60, [1, 100, 'claude-opus-5', 0.5]),
        'm' => str_repeat('Z', 4000),
    ]);
    [$c, $j] = call('POST', ['snapshot' => $dirty, 'urlMode' => 'host']);
    ok($c === 200, "带多余字段的快照仍应保存成功，实际 $c");
    $clean = (string) @file_get_contents("$tmp/shares/" . ($j['id'] ?? '') . ".json");
    ok(strpos($clean, 'sk-must-not-be-stored') === false, 'API Key 绝不能落盘');
    ok(strpos($clean, '"evil"') === false, '白名单外字段不应落盘');
    $saved = json_decode($clean, true);
    ok(count($saved['rk'] ?? []) <= 6, 'rank 应截到 6 条');
    ok(count($saved['rs'] ?? []) <= 20, 'responses 应截到 20 条');
    ok(mb_strlen((string) ($saved['m'] ?? '')) <= 512, '超长字符串应被截断');

    // ---- ⑤ 体过大 / 限流 ----
    $huge = json_encode(['snapshot' => snap(['evil' => str_repeat('x', 600000)]), 'urlMode' => 'host']);
    [$c] = call('POST', $huge);
    ok($c === 413, "请求体过大应 413，实际 $c");

    // ---- ⑥ 超量删最旧（MT_MAX_SHARES=5）----
    // ⚠️ 每条快照的内容必须**两两不同**，否则内容寻址会把它们归并成同一个 id，
    // 循环就变成「反复复用同一条」，测不到回收。这里同时改 model 和概率。
    // 排序依据是文档里的 _c（毫秒），所以 20ms 的间隔足够分出先后 ——
    // 这正是 _c 存在的理由：靠 mtime 的话这些文件会落在同一秒里，顺序不可控。
    $ids = [];
    for ($i = 0; $i < 8; $i++) {
        [$c, $j] = call('POST', ['snapshot' => snap([
            'm' => 'model-' . $i,
            'rk' => [['model-' . $i, 0.5 + $i / 100]],
        ]), 'urlMode' => 'host']);
        ok($c === 200, "第 " . ($i + 1) . " 次保存应成功，实际 $c");
        $ids[] = $j['id'] ?? '';
        usleep(20000);
    }
    ok(count(array_unique($ids)) === 8, '8 条内容不同的快照应得到 8 个不同的 id');
    $files = glob("$tmp/shares/*.json") ?: [];
    ok(count($files) <= 5, "分享数应被压到上限内，实际 " . count($files));
    ok(!is_file("$tmp/shares/{$ids[0]}.json"), '最旧的分享应被回收');
    ok(is_file("$tmp/shares/{$ids[7]}.json"), '最新的分享应保留');
    [$c] = call('GET', null, 'id=' . urlencode($ids[7]));
    ok($c === 200, '回收后最新分享仍应可读');

    // ---- 非法 id ----
    // '../config' 形状不合法，能在进到文件系统之前就被挡下（400 是期望结果；
    // 这里放宽到 400/404 是因为「先校验形状还是先查文件」是实现细节，两者都算挡住）
    [$c] = call('GET', null, 'id=../config');
    ok($c === 400 || $c === 404, "路径穿越式 id 应被拒，实际 $c");
    // 形状合法（a + 9 位 base36，共 10 字符）但不存在的 id ——
    // 走到查文件那一步，必须是 404 而不是 400
    $missing = 'a' . str_repeat('z', 9);
    [$c] = call('GET', null, 'id=' . urlencode($missing));
    ok($c === 404, "形状合法但不存在的 id 应 404，实际 $c");
    // 27 位的老形状也仍然合法（老链接要能继续读到）—— 这里只是它不存在，所以也是 404
    [$c] = call('GET', null, 'id=' . urlencode('a' . str_repeat('z', 27)));
    ok($c === 404, "旧形状 id 应仍被视为合法（走到查文件），实际 $c");

    // ---- 限流 ----
    $codes = [];
    for ($i = 0; $i < 45; $i++) { [$c] = call('GET', null, 'id=' . urlencode($missing)); $codes[] = $c; }
    ok(in_array(429, $codes, true), '超出限流阈值应出现 429');
} finally {
    proc_terminate($proc);
    proc_close($proc);
    $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($tmp, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
    foreach ($it as $f) { $f->isDir() ? @rmdir($f->getPathname()) : @unlink($f->getPathname()); }
    @rmdir($tmp);
}

echo "share_api: $pass passed, $fail failed\n";
exit($fail ? 1 : 0);
