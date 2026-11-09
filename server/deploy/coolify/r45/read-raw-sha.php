<?php
// read-raw-sha.php: READ-ONLY. Prints the sha256 and the length of the stored compose of the SSAM service, nothing else
// (the compose holds secrets). Run: docker exec -i coolify php < read-raw-sha.php
require '/var/www/html/vendor/autoload.php';
$app = require '/var/www/html/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
$s = App\Models\Service::where('uuid', 'ksqommjgowjjilpgpbmf7cdo')->sole();
echo json_encode(['rawSha256' => hash('sha256', $s->docker_compose_raw), 'bytes' => strlen($s->docker_compose_raw)]), "\n";
