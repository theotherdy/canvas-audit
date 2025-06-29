<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Bus\Batch;
use Illuminate\Support\Facades\Bus;
use Illuminate\Support\Facades\DB;
use App\Models\AuditBatch;
use App\Jobs\AuditCourseJob;

class AuditController extends Controller
{
    /* -------------------------------------------------
     * GET /   → show textarea for course IDs
     * ------------------------------------------------- */
    public function index()
    {
        return view('audit.home');
    }

    /* -------------------------------------------------
     * POST /audit   → validate, create AuditBatch, dispatch jobs
     * ------------------------------------------------- */
    public function store(Request $request)
    {
        /* 1. Turn the textarea into a unique collection of ints */
        $ids = collect(preg_split('/[\s,]+/', trim($request->input('course_ids'))))
            ->filter()
            ->map(fn ($id) => (int) $id)
            ->unique();

        if ($ids->isEmpty()) {
            return back()->withErrors(['course_ids' => 'Please enter at least one course ID.']);
        }

        /* 2. Everything inside one DB transaction so the wrapper row
              and the Bus batch stay consistent even if something fails. */
        $auditBatch = DB::transaction(function () use ($ids) {

            // 2a. Create wrapper row (status = pending)
            $auditBatch = AuditBatch::create([
                'total_jobs' => $ids->count(),
                'status'     => 'pending',
            ]);

            // 2b. Dispatch the Bus batch
            $busBatch = Bus::batch(
                $ids->map(fn ($id) => new AuditCourseJob($id, $auditBatch->id))  // auditBatchId param
            )
            ->name("Audit batch #{$auditBatch->id}")
            ->then(function (Batch $batch) use ($auditBatch) {
                $auditBatch->update([
                    'processed_jobs' => $batch->processedJobs(),  // ← method
                    'status'         => 'finished',
                    'finished_at'    => now(),
                ]);
            })
            ->catch(function (Batch $batch, \Throwable $e) use ($auditBatch) {
                $auditBatch->update([
                    'processed_jobs' => $batch->processedJobs(),  // ← method
                    'failed_jobs'    => $batch->failedJobs,
                    'failed_job_ids' => $batch->failedJobIds,
                    'status'         => 'failed',
                    'finished_at'    => now(),
                ]);
            })
            ->finally(function (Batch $batch) use ($auditBatch) {
                // keep counts in sync even if nothing failed
                if ($batch->finished()) {
                    $auditBatch->update([
                        'processed_jobs' => $batch->processedJobs(),  // ← method
                        'failed_jobs'    => $batch->failedJobs,
                    ]);
                }
            })
            ->dispatch();

            // 2c. Persist the Bus UUID and mark running
            $auditBatch->update([
                'job_batch_id' => $busBatch->id,
                'status'       => 'running',
                'started_at'   => now(),
            ]);

            return $auditBatch;   // returned to outer scope
        });

        /* 3. Redirect admin to progress page */
        return redirect()->route('audit.show', $auditBatch);
    }

    /* -------------------------------------------------
     * GET /audit/{batch}   → Livewire progress + final table
     * ------------------------------------------------- */
    public function show(AuditBatch $batch)
    {
        $batch->load('results');   // eager-load rows for the DataTable
        return view('audit.show', compact('batch'));
    }
}
