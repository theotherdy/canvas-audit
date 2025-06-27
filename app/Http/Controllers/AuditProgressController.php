<?php

namespace App\Http\Controllers;

use App\Models\AuditBatch;
use Illuminate\Http\JsonResponse;

class AuditProgressController extends Controller
{
    public function __invoke(AuditBatch $batch): JsonResponse
    {
        return response()->json([
            'processed' => $batch->processed_jobs,
            'total'     => $batch->total_jobs,
            'percent'   => $batch->progress(),
            'status'    => $batch->status,
        ]);
    }
}
