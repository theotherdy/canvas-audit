<?php
namespace App\Services;

use Illuminate\Support\Facades\Http;

class Canvas
{
    protected string $api;

    public function __construct()
    {
        $this->api = config('services.canvas.domain').'/api/v1/';
    }

    protected function client()
    {
        return Http::withToken(config('services.canvas.token'))
                   ->baseUrl($this->api)
                   ->timeout(60);
    }

    public function get(string $url)   { return $this->client()->get($url)->json(); }
    public function paged(string $url): array
    {
        $out=[]; $next=$url;
        while ($next) {
            $res = $this->client()->get($next);
            $out = array_merge($out, $res->json());
            $next = null;
            if ($link=$res->header('Link')) {
                foreach (explode(',', $link) as $l)
                    if (str_contains($l,'rel="next"'))
                        $next = trim(strtok(trim($l),' ;><'));
            }
            usleep(800000); // 0.8s throttle
        }
        return $out;
    }
}
