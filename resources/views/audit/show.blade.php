{{-- resources/views/audit/show.blade.php --}}
@extends('layouts.app')

@section('content')
<div class="container mt-4">
    <h1 class="h4 mb-3">Audit Batch #{{ $batch->id }}</h1>

    {{-- Live, auto-refreshing progress bar --}}
    <livewire:batch-progress :batch="$batch" />

    @if ($batch->status === 'finished')
        <hr>
        <h2 class="h5 mt-4">Results</h2>

        <div class="table-responsive">
            <table id="results" class="table table-sm table-bordered table-striped">
                <thead>
                    <tr>
                        <th>Course ID</th>
                        <th>Pages</th>
                        <th>Classic Quizzes</th>
                        <th>New Quizzes</th>
                        <th>Other Assignments</th>
                        <th>Discussions</th>
                        <th>Active Students</th>
                        <th>Quiz Eng.</th>
                        <th>Assign. Eng.</th>
                        <th>Disc. Eng.</th>
                    </tr>
                </thead>
                <tbody>
                    @foreach ($batch->results as $r)
                        <tr>
                            <td>{{ $r->course_id }}</td>
                            <td>{{ $r->published_pages }}</td>
                            <td>{{ $r->classic_quizzes }}</td>
                            <td>{{ $r->new_quizzes }}</td>
                            <td>{{ $r->other_assignments }}</td>
                            <td>{{ $r->discussions }}</td>
                            <td>{{ $r->active_students }}</td>
                            <td>{{ number_format($r->quiz_engagement * 100, 1) }}%</td>
                            <td>{{ number_format($r->assignment_engagement * 100, 1) }}%</td>
                            <td>{{ number_format($r->discussion_engagement * 100, 1) }}%</td>
                        </tr>
                    @endforeach
                </tbody>
            </table>
        </div>

    @elseif ($batch->status === 'failed')
        <div class="alert alert-danger mt-4">
            Some jobs failed ({{ $batch->failed_jobs }}). Please check the logs for details.
        </div>
    @endif
</div>
@endsection


{{-- Only load DataTables once results exist --}}
@push('scripts')
@if ($batch->status === 'finished')
    <script src="https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/datatables.net@2.0.5/js/dataTables.min.js"></script>
    <script>
        $(function () { $('#results').DataTable(); });
    </script>
@endif
@endpush
