<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Bus\Batch;
use Illuminate\Support\Facades\Bus;
use Illuminate\Support\Facades\DB;
use App\Models\AuditBatch;
use App\Jobs\AuditCourseJob;          // one job per course

class AuditController extends Controller
{
    /* -------------------------------------------------
     * Show the “Enter course IDs” form
     * ------------------------------------------------- */
    public function index()
    {
        return view('audit.home');
    }

    /* -------------------------------------------------
     * POST /audit   → create batch + dispatch jobs
     * ------------------------------------------------- */
    public function store(Request $request)
    {
        // 1. Validate (comma- or space-separated values -> array of ints)
        $ids = collect(
            preg_split('/[\s,]+/', trim($request->input('course_ids')))
        )
        ->filter()
        ->map(fn ($id) => (int) $id)
        ->unique();

        if ($ids->isEmpty()) {
            return back()->withErrors('Please enter at least one course ID.');
        }

        /* 2. Wrap everything in a DB transaction so the AuditBatch row
         *    and the Bus batch stay in sync even if something fails.
         */
        DB::beginTransaction();

        // 2a. Create the wrapper row (status = pending for now)
        $auditBatch = AuditBatch::create([
            'total_jobs' => $ids->count(),
            'status'     => 'pending',
        ]);

        // 2b. Dispatch the Bus batch
        $busBatch = Bus::batch(
            $ids->map(fn ($id) => new AuditCourseJob($id, $auditBatch->id))
        )
        ->name("Audit batch #{$auditBatch->id}")
        ->then(function (Batch $batch) use ($auditBatch) {
            // success callback
            $auditBatch->update([
                'processed_jobs' => $batch->processedJobs(),
                'status'         => 'finished',
                'finished_at'    => now(),
            ]);
        })
        ->catch(function (Batch $batch, \Throwable $e) use ($auditBatch) {
            // failure callback
            $auditBatch->update([
                'processed_jobs' => $batch->processedJobs(),
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
                    'processed_jobs' => $batch->processedJobs,
                    'failed_jobs'    => $batch->failedJobs,
                ]);
            }
        })
        ->dispatch();   // <-- launches the queue work

        // 2c. Store the Bus UUID so Livewire can query it later if needed
        $auditBatch->update([
            'job_batch_id' => $busBatch->id,
            'status'       => 'running',
            'started_at'   => now(),
        ]);

        DB::commit();

        // 3. Redirect user to the progress page
        return redirect()->route('audit.show', $auditBatch);
    }

    /* -------------------------------------------------
     * GET /audit/{batch}   → progress + results
     * ------------------------------------------------- */
    public function show(AuditBatch $batch)
    {
        // Eager-load results so the view has them once finished
        $batch->load('results');

        return view('audit.show', compact('batch'));
    }
}
